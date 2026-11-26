// Zyad Chat App — WhatsApp-style messaging, standalone (Node.js + Express + PostgreSQL)
// No phone/SMS signup (username + password accounts), no end-to-end encryption
// (messages are stored on the server), no voice/video calls in v1.
// Media is stored in Postgres (bytea) so free-tier disk wipes lose nothing.

const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_MEDIA_BYTES = 12 * 1024 * 1024; // 12 MB per upload

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  about TEXT DEFAULT '',
  photo BYTEA,
  photo_mime TEXT,
  last_seen TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('dm','group')),
  name TEXT,
  photo BYTEA,
  photo_mime TEXT,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ DEFAULT now(),
  joined_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INT REFERENCES users(id),
  body TEXT,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','video','audio')),
  media BYTEA,
  media_mime TEXT,
  media_name TEXT,
  reply_to INT REFERENCES messages(id) ON DELETE SET NULL,
  deleted_for_all BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS message_hidden (
  message_id INT REFERENCES messages(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);
CREATE TABLE IF NOT EXISTS message_deliveries (
  message_id INT REFERENCES messages(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE TABLE IF NOT EXISTS message_reads (
  message_id INT REFERENCES messages(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INT REFERENCES messages(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
`;

async function initDb() {
  await pool.query(SCHEMA);
  console.log('Database schema ready');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isOnline(lastSeen) {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < 45 * 1000;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    about: row.about || '',
    hasPhoto: !!row.photo,
    lastSeen: row.last_seen,
    online: isOnline(row.last_seen),
  };
}

// Auth: token from "Authorization: Bearer <token>" header or ?token= query param
// (query param is needed for <img>/<video> media URLs, which cannot send headers).
async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { rows } = await pool.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1`,
      [token]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid session' });
    req.user = rows[0];
    req.token = token;
    // Touch last_seen on every authenticated request (cheap presence signal).
    pool.query('UPDATE users SET last_seen = now() WHERE id = $1', [req.user.id]).catch(() => {});
    next();
  } catch (err) {
    console.error('auth error', err);
    res.status(500).json({ error: 'Server error' });
  }
}

async function isMember(conversationId, userId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  );
  return rows.length > 0;
}

async function memberIds(conversationId) {
  const { rows } = await pool.query(
    'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
    [conversationId]
  );
  return rows.map((r) => r.user_id);
}

// Tick status for one message, given the other member ids.
function tickStatus(msg, otherIds, deliveries, reads) {
  if (!otherIds.length) return 'sent';
  const delivered = otherIds.every(
    (id) => deliveries.has(`${msg.id}:${id}`) || reads.has(`${msg.id}:${id}`)
  );
  if (!delivered) return 'sent';
  const read = otherIds.every((id) => reads.has(`${msg.id}:${id}`));
  return read ? 'read' : 'delivered';
}

// Shape a message row for the client, hiding media bytes (served via /api/media/:id).
function shapeMessage(row, ctx) {
  const deleted = !!row.deleted_for_all;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderUsername: row.sender_username,
    body: deleted ? null : row.body,
    kind: deleted ? 'text' : row.kind,
    hasMedia: !deleted && !!row.media,
    mediaMime: deleted ? null : row.media_mime,
    mediaName: deleted ? null : row.media_name,
    replyTo: row.reply_to
      ? {
          id: row.reply_to,
          senderName: row.reply_sender_name,
          body: row.reply_deleted ? null : row.reply_body,
          kind: row.reply_deleted ? 'text' : row.reply_kind,
        }
      : null,
    deletedForAll: deleted,
    ticks: ctx && row.sender_id === ctx.me ? tickStatus(row, ctx.others, ctx.deliveries, ctx.reads) : null,
    reactions: ctx ? ctx.reactions[row.id] || [] : [],
    createdAt: row.created_at,
  };
}

function decodeMedia(b64) {
  if (!b64) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_MEDIA_BYTES) return { error: 'File too large (max 12 MB)' };
  return { buf };
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.post('/api/register', async (req, res) => {
  const { username, password, displayName } = req.body || {};
  const name = String(username || '').trim().toLowerCase();
  const pass = String(password || '');
  const disp = String(displayName || '').trim() || name;
  if (!/^[a-z0-9_]{3,20}$/.test(name)) {
    return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or _' });
  }
  if (pass.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (disp.length > 40) return res.status(400).json({ error: 'Display name too long' });
  try {
    const hash = await bcrypt.hash(pass, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash, display_name) VALUES ($1,$2,$3) RETURNING *',
      [name, hash, disp]
    );
    const token = newToken();
    await pool.query('INSERT INTO sessions (user_id, token) VALUES ($1,$2)', [rows[0].id, token]);
    res.json({ token, user: publicUser(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Username already taken' });
    console.error('register error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const name = String(username || '').trim().toLowerCase();
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [name]);
    if (!rows.length) return res.status(400).json({ error: 'Wrong username or password' });
    const ok = await bcrypt.compare(String(password || ''), rows[0].password_hash);
    if (!ok) return res.status(400).json({ error: 'Wrong username or password' });
    const token = newToken();
    await pool.query('INSERT INTO sessions (user_id, token) VALUES ($1,$2)', [rows[0].id, token]);
    await pool.query('UPDATE users SET last_seen = now() WHERE id = $1', [rows[0].id]);
    res.json({ token, user: publicUser(rows[0]) });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/logout', auth, async (req, res) => {
  await pool.query('DELETE FROM sessions WHERE token = $1', [req.token]);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/me/heartbeat', auth, async (req, res) => {
  await pool.query('UPDATE users SET last_seen = now() WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------
app.get('/api/users', auth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const { rows } = await pool.query(
    q
      ? `SELECT * FROM users WHERE id <> $1 AND (username ILIKE $2 OR display_name ILIKE $2) ORDER BY display_name LIMIT 50`
      : `SELECT * FROM users WHERE id <> $1 ORDER BY display_name LIMIT 50`,
    q ? [req.user.id, `%${q}%`] : [req.user.id]
  );
  res.json({ users: rows.map(publicUser) });
});

app.get('/api/users/:id', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(rows[0]) });
});

app.put('/api/me/profile', auth, async (req, res) => {
  const { displayName, about, photoBase64, photoMime } = req.body || {};
  const disp = String(displayName || '').trim();
  const aboutText = String(about || '').slice(0, 140);
  if (disp && disp.length > 40) return res.status(400).json({ error: 'Display name too long' });
  let photo = null;
  let mime = null;
  if (photoBase64) {
    const decoded = decodeMedia(photoBase64);
    if (decoded && decoded.error) return res.status(400).json({ error: decoded.error });
    if (decoded) {
      photo = decoded.buf;
      mime = String(photoMime || 'image/jpeg');
    }
  }
  try {
    const { rows } = await pool.query(
      `UPDATE users SET
         display_name = COALESCE(NULLIF($1,''), display_name),
         about = $2,
         photo = CASE WHEN $3::bytea IS NULL THEN photo ELSE $3 END,
         photo_mime = CASE WHEN $3::bytea IS NULL THEN photo_mime ELSE $4 END
       WHERE id = $5 RETURNING *`,
      [disp, aboutText, photo, mime, req.user.id]
    );
    res.json({ user: publicUser(rows[0]) });
  } catch (err) {
    console.error('profile error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Avatar image (own photo or another user's). Public URL — avatars are not private.
app.get('/api/avatar/:userId', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT photo, photo_mime FROM users WHERE id = $1', [
      req.params.userId,
    ]);
    if (!rows.length || !rows[0].photo) return res.status(404).end();
    res.set('Content-Type', rows[0].photo_mime || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(rows[0].photo);
  } catch (err) {
    res.status(500).end();
  }
});

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------
app.get('/api/conversations', auth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  try {
    const { rows: convs } = await pool.query(
      `SELECT c.* FROM conversations c
       JOIN conversation_members m ON m.conversation_id = c.id
       WHERE m.user_id = $1 ORDER BY c.id DESC`,
      [req.user.id]
    );
    const out = [];
    for (const c of convs) {
      const { rows: members } = await pool.query(
        `SELECT u.* FROM conversation_members m JOIN users u ON u.id = m.user_id
         WHERE m.conversation_id = $1`,
        [c.id]
      );
      const { rows: lastRows } = await pool.query(
        `SELECT m.*, u.display_name AS sender_name FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = $1
           AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = $2)
         ORDER BY m.id DESC LIMIT 1`,
        [c.id, req.user.id]
      );
      const { rows: unreadRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM messages m
         JOIN conversation_members mem ON mem.conversation_id = m.conversation_id AND mem.user_id = $2
         WHERE m.conversation_id = $1 AND m.sender_id <> $2
           AND m.created_at > mem.last_read_at AND m.deleted_for_all = FALSE
           AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = $2)`,
        [c.id, req.user.id]
      );
      let title = c.name || '';
      let photoUserId = null;
      let peer = null;
      if (c.type === 'dm') {
        peer = members.find((u) => u.id !== req.user.id);
        if (peer) {
          title = peer.display_name;
          photoUserId = peer.id;
        }
      }
      const last = lastRows[0];
      if (q) {
        const hay = `${title} ${peer ? peer.username : ''} ${c.name || ''}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) continue;
      }
      out.push({
        id: c.id,
        type: c.type,
        title,
        peer: peer ? publicUser(peer) : null,
        hasPhoto: c.type === 'group' ? !!c.photo : !!peer?.photo,
        photoUserId,
        lastMessage: last
          ? {
              body: last.deleted_for_all ? 'This message was deleted' : last.body,
              kind: last.deleted_for_all ? 'text' : last.kind,
              senderName: last.sender_name,
              createdAt: last.created_at,
            }
          : null,
        unread: unreadRows[0]?.n || 0,
      });
    }
    // Most recent activity first.
    out.sort((a, b) => {
      const ta = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
      const tb = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
      return tb - ta;
    });
    res.json({ conversations: out });
  } catch (err) {
    console.error('conversations error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/conversations/dm', auth, async (req, res) => {
  const otherId = parseInt(req.body.userId, 10);
  if (!otherId || otherId === req.user.id) return res.status(400).json({ error: 'Invalid user' });
  try {
    const { rows: userRows } = await pool.query('SELECT id FROM users WHERE id = $1', [otherId]);
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });
    const { rows: existing } = await pool.query(
      `SELECT c.id FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = $1
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = $2
       WHERE c.type = 'dm'`,
      [req.user.id, otherId]
    );
    if (existing.length) return res.json({ conversationId: existing[0].id });
    const { rows: conv } = await pool.query(
      `INSERT INTO conversations (type, created_by) VALUES ('dm', $1) RETURNING id`,
      [req.user.id]
    );
    await pool.query(
      'INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2), ($1,$3)',
      [conv[0].id, req.user.id, otherId]
    );
    res.json({ conversationId: conv[0].id });
  } catch (err) {
    console.error('dm error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/conversations/group', auth, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  const memberIdsRaw = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];
  if (!name) return res.status(400).json({ error: 'Group name is required' });
  const ids = [...new Set(memberIdsRaw.map((v) => parseInt(v, 10)).filter((v) => v && v !== req.user.id))];
  try {
    const { rows: conv } = await pool.query(
      `INSERT INTO conversations (type, name, created_by) VALUES ('group', $1, $2) RETURNING id`,
      [name, req.user.id]
    );
    const all = [req.user.id, ...ids];
    for (const uid of all) {
      await pool.query(
        'INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [conv[0].id, uid]
      );
    }
    res.json({ conversationId: conv[0].id });
  } catch (err) {
    console.error('group error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/conversations/:id/members', auth, async (req, res) => {
  const cid = parseInt(req.params.id, 10);
  if (!(await isMember(cid, req.user.id))) return res.status(403).json({ error: 'Not a member' });
  const { rows } = await pool.query(
    `SELECT u.* FROM conversation_members m JOIN users u ON u.id = m.user_id
     WHERE m.conversation_id = $1 ORDER BY u.display_name`,
    [cid]
  );
  res.json({ members: rows.map(publicUser) });
});

app.post('/api/conversations/:id/members', auth, async (req, res) => {
  const cid = parseInt(req.params.id, 10);
  const addId = parseInt(req.body.userId, 10);
  if (!(await isMember(cid, req.user.id))) return res.status(403).json({ error: 'Not a member' });
  if (!addId) return res.status(400).json({ error: 'Invalid user' });
  await pool.query(
    'INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [cid, addId]
  );
  res.json({ ok: true });
});

app.post('/api/conversations/:id/read', auth, async (req, res) => {
  const cid = parseInt(req.params.id, 10);
  if (!(await isMember(cid, req.user.id))) return res.status(403).json({ error: 'Not a member' });
  try {
    await pool.query(
      `INSERT INTO message_reads (message_id, user_id)
       SELECT id, $2 FROM messages WHERE conversation_id = $1 AND sender_id <> $2
       ON CONFLICT DO NOTHING`,
      [cid, req.user.id]
    );
    await pool.query(
      'UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2',
      [cid, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('read error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
async function loadMessageContext(conversationId, me) {
  const others = (await memberIds(conversationId)).filter((id) => id !== me);
  const { rows: dRows } = await pool.query(
    `SELECT message_id, user_id FROM message_deliveries d
     JOIN messages m ON m.id = d.message_id WHERE m.conversation_id = $1`,
    [conversationId]
  );
  const { rows: rRows } = await pool.query(
    `SELECT message_id, user_id FROM message_reads r
     JOIN messages m ON m.id = r.message_id WHERE m.conversation_id = $1`,
    [conversationId]
  );
  const { rows: reactRows } = await pool.query(
    `SELECT r.message_id, r.emoji, r.user_id, u.display_name FROM reactions r
     JOIN users u ON u.id = r.user_id
     JOIN messages m ON m.id = r.message_id WHERE m.conversation_id = $1`,
    [conversationId]
  );
  const deliveries = new Set(dRows.map((r) => `${r.message_id}:${r.user_id}`));
  const reads = new Set(rRows.map((r) => `${r.message_id}:${r.user_id}`));
  const reactions = {};
  for (const r of reactRows) {
    reactions[r.message_id] = reactions[r.message_id] || [];
    reactions[r.message_id].push({ emoji: r.emoji, userId: r.user_id, userName: r.display_name });
  }
  return { me, others, deliveries, reads, reactions };
}

const MESSAGE_SELECT = `
  SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
    ru.display_name AS reply_sender_name, rm.body AS reply_body,
    rm.kind AS reply_kind, rm.deleted_for_all AS reply_deleted
  FROM messages m
  JOIN users u ON u.id = m.sender_id
  LEFT JOIN messages rm ON rm.id = m.reply_to
  LEFT JOIN users ru ON ru.id = rm.sender_id
`;

app.get('/api/conversations/:id/messages', auth, async (req, res) => {
  const cid = parseInt(req.params.id, 10);
  if (!(await isMember(cid, req.user.id))) return res.status(403).json({ error: 'Not a member' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const after = parseInt(req.query.after, 10) || 0;
  const before = parseInt(req.query.before, 10) || 0;
  const search = String(req.query.q || '').trim();
  try {
    let sql = `${MESSAGE_SELECT} WHERE m.conversation_id = $1
      AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = $2)`;
    const params = [cid, req.user.id];
    if (after) {
      sql += ` AND m.id > $${params.length + 1}`;
      params.push(after);
    }
    if (before) {
      sql += ` AND m.id < $${params.length + 1}`;
      params.push(before);
    }
    if (search) {
      sql += ` AND m.body ILIKE $${params.length + 1}`;
      params.push(`%${search}%`);
    }
    sql += ` ORDER BY m.id ${before ? 'DESC' : 'ASC'} LIMIT $${params.length + 1}`;
    params.push(limit);
    const { rows } = await pool.query(sql, params);
    const ordered = before ? rows.reverse() : rows;
    // Record delivery for messages from others that this user just received.
    if (ordered.length) {
      const ids = ordered.filter((m) => m.sender_id !== req.user.id).map((m) => m.id);
      for (const mid of ids) {
        await pool.query(
          'INSERT INTO message_deliveries (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [mid, req.user.id]
        );
      }
    }
    const ctx = await loadMessageContext(cid, req.user.id);
    res.json({ messages: ordered.map((m) => shapeMessage(m, ctx)) });
  } catch (err) {
    console.error('messages error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/conversations/:id/messages', auth, async (req, res) => {
  const cid = parseInt(req.params.id, 10);
  if (!(await isMember(cid, req.user.id))) return res.status(403).json({ error: 'Not a member' });
  const { body, kind, mediaBase64, mediaMime, mediaName, replyTo } = req.body || {};
  const text = String(body || '').slice(0, 4000);
  const msgKind = ['text', 'image', 'video', 'audio'].includes(kind) ? kind : 'text';
  if (msgKind === 'text' && !text.trim()) return res.status(400).json({ error: 'Message is empty' });
  let media = null;
  let mime = null;
  if (msgKind !== 'text') {
    if (!mediaBase64) return res.status(400).json({ error: 'Media is required' });
    const decoded = decodeMedia(mediaBase64);
    if (decoded && decoded.error) return res.status(400).json({ error: decoded.error });
    media = decoded.buf;
    mime = String(mediaMime || 'application/octet-stream');
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, body, kind, media, media_mime, media_name, reply_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        cid,
        req.user.id,
        msgKind === 'text' ? text : text || null,
        msgKind,
        media,
        mime,
        mediaName ? String(mediaName).slice(0, 120) : null,
        replyTo ? parseInt(replyTo, 10) || null : null,
      ]
    );
    const { rows: full } = await pool.query(`${MESSAGE_SELECT} WHERE m.id = $1`, [rows[0].id]);
    const ctx = await loadMessageContext(cid, req.user.id);
    res.json({ message: shapeMessage(full[0], ctx) });
  } catch (err) {
    console.error('send error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve a message's media file (member-only).
app.get('/api/media/:messageId', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [req.params.messageId]);
    if (!rows.length || !rows[0].media) return res.status(404).end();
    if (!(await isMember(rows[0].conversation_id, req.user.id))) return res.status(403).end();
    if (rows[0].deleted_for_all) return res.status(410).end();
    res.set('Content-Type', rows[0].media_mime || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(rows[0].media);
  } catch (err) {
    res.status(500).end();
  }
});

app.post('/api/messages/:id/react', auth, async (req, res) => {
  const mid = parseInt(req.params.id, 10);
  const emoji = String(req.body.emoji || '').slice(0, 8);
  if (!emoji) return res.status(400).json({ error: 'Emoji is required' });
  try {
    const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [mid]);
    if (!rows.length) return res.status(404).json({ error: 'Message not found' });
    if (!(await isMember(rows[0].conversation_id, req.user.id))) {
      return res.status(403).json({ error: 'Not a member' });
    }
    const { rows: existing } = await pool.query(
      'SELECT emoji FROM reactions WHERE message_id = $1 AND user_id = $2',
      [mid, req.user.id]
    );
    if (existing.length && existing[0].emoji === emoji) {
      await pool.query('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2', [mid, req.user.id]);
    } else {
      await pool.query(
        `INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1,$2,$3)
         ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji`,
        [mid, req.user.id, emoji]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('react error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/messages/:id/delete', auth, async (req, res) => {
  const mid = parseInt(req.params.id, 10);
  const mode = req.body.mode === 'everyone' ? 'everyone' : 'me';
  try {
    const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [mid]);
    if (!rows.length) return res.status(404).json({ error: 'Message not found' });
    if (!(await isMember(rows[0].conversation_id, req.user.id))) {
      return res.status(403).json({ error: 'Not a member' });
    }
    if (mode === 'everyone') {
      if (rows[0].sender_id !== req.user.id) {
        return res.status(403).json({ error: 'Only the sender can delete for everyone' });
      }
      await pool.query(
        'UPDATE messages SET deleted_for_all = TRUE, body = NULL, media = NULL WHERE id = $1',
        [mid]
      );
    } else {
      await pool.query(
        'INSERT INTO message_hidden (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [mid, req.user.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('delete error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// Typing indicator (ephemeral, kept in server memory)
// ---------------------------------------------------------------------------
const typingMap = new Map(); // key: `${conversationId}:${userId}` -> timestamp
app.post('/api/conversations/:id/typing', auth, async (req, res) => {
  const cid = parseInt(req.params.id, 10);
  if (!(await isMember(cid, req.user.id))) return res.status(403).json({ error: 'Not a member' });
  typingMap.set(`${cid}:${req.user.id}`, Date.now());
  res.json({ ok: true });
});

app.get('/api/conversations/:id/typing', auth, async (req, res) => {
  const cid = parseInt(req.params.id, 10);
  if (!(await isMember(cid, req.user.id))) return res.status(403).json({ error: 'Not a member' });
  const now = Date.now();
  const typing = [];
  for (const [key, ts] of typingMap.entries()) {
    const [c, u] = key.split(':');
    if (parseInt(c, 10) === cid && parseInt(u, 10) !== req.user.id && now - ts < 5000) {
      typing.push(parseInt(u, 10));
    } else if (now - ts >= 5000) {
      typingMap.delete(key);
    }
  }
  if (!typing.length) return res.json({ typing: [] });
  const { rows } = await pool.query(
    'SELECT id, display_name FROM users WHERE id = ANY($1)',
    [typing]
  );
  res.json({ typing: rows.map((r) => ({ userId: r.id, displayName: r.display_name })) });
});

// ---------------------------------------------------------------------------
// Frontend + health
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Unknown /api paths get JSON 404s (not the frontend HTML).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Zyad Chat App listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to start — check DATABASE_URL:', err.message);
    process.exit(1);
  });
