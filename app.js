// Zyad Chat — frontend (plain JS, polling-based realtime)
const API = '/api';
let token = localStorage.getItem('zyadchat_token') || null;
let me = null;
let conversations = [];
let currentChat = null; // {id, type, title, peer, ...}
let currentMessages = [];
let replyTo = null;
let pollTimer = null;
let mediaRecorder = null;
let recordingChunks = [];
let lastTypingSent = 0;

const $ = (id) => document.getElementById(id);

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
}
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(opts.needsAuth === false ? {} : authHeaders()) },
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status));
  return data;
}
function avatarHtml(user, cls, id) {
  const initial = (user.displayName || user.username || '?')[0].toUpperCase();
  const idAttr = id ? ` id="${id}"` : '';
  if (user.hasPhoto) {
    return `<span class="avatar ${cls || ''}"${idAttr}><img src="${API}/avatar/${user.id}" alt=""></span>`;
  }
  return `<span class="avatar ${cls || ''}"${idAttr}>${escapeHtml(initial)}</span>`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now - 86400000).toDateString() === d.toDateString();
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return t;
  if (yesterday) return 'Yesterday';
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function fmtDay(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (new Date(now - 86400000).toDateString() === d.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function lastSeenText(user) {
  if (!user) return '';
  if (user.online) return 'online';
  if (!user.lastSeen) return '';
  const mins = Math.floor((Date.now() - new Date(user.lastSeen).getTime()) / 60000);
  if (mins < 1) return 'last seen just now';
  if (mins < 60) return `last seen ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `last seen ${hrs} h ago`;
  return 'last seen ' + new Date(user.lastSeen).toLocaleDateString();
}

// ---------------- Auth ----------------
function showTab(which) {
  $('tab-login').classList.toggle('active', which === 'login');
  $('tab-register').classList.toggle('active', which === 'register');
  $('login-form').classList.toggle('hidden', which !== 'login');
  $('register-form').classList.toggle('hidden', which !== 'register');
  $('auth-error').textContent = '';
}
async function doLogin() {
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  try {
    const d = await api('/login', { method: 'POST', needsAuth: false, body: JSON.stringify({ username, password }) });
    afterAuth(d);
  } catch (e) { $('auth-error').textContent = e.message; }
}
async function doRegister() {
  const displayName = $('reg-display').value.trim();
  const username = $('reg-username').value.trim();
  const password = $('reg-password').value;
  try {
    const d = await api('/register', { method: 'POST', needsAuth: false, body: JSON.stringify({ username, password, displayName }) });
    afterAuth(d);
  } catch (e) { $('auth-error').textContent = e.message; }
}
function afterAuth(d) {
  token = d.token;
  me = d.user;
  localStorage.setItem('zyadchat_token', token);
  $('auth-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('me-name').textContent = me.displayName;
  $('me-avatar').outerHTML = avatarHtml(me, '', 'me-avatar');
  startPolling();
  refreshConversations();
}
async function doLogout() {
  try { await api('/logout', { method: 'POST' }); } catch (e) {}
  token = null; me = null; currentChat = null;
  localStorage.removeItem('zyadchat_token');
  clearInterval(pollTimer);
  $('app-view').classList.add('hidden');
  $('auth-view').classList.remove('hidden');
}

// ---------------- Conversations ----------------
async function refreshConversations() {
  if (!me) return;
  try {
    const d = await api('/conversations');
    conversations = d.conversations;
    renderChatList();
  } catch (e) { /* session may have expired; ignore transient errors */ }
}
function renderChatList() {
  const q = ($('chat-search').value || '').toLowerCase();
  const list = $('chat-list');
  const items = conversations.filter((c) => !q || (c.title + ' ' + (c.peer?.username || '')).toLowerCase().includes(q));
  if (!items.length) {
    list.innerHTML = '<p style="padding:24px;color:#667781;text-align:center">No chats yet.<br>Tap 💬 to start one.</p>';
    return;
  }
  list.innerHTML = items.map((c) => {
    const last = c.lastMessage;
    const preview = last
      ? (last.kind === 'text' ? (last.body || '') : (last.kind === 'image' ? '📷 Photo' : last.kind === 'video' ? '🎥 Video' : '🎤 Voice note'))
      : 'No messages yet';
    const senderPrefix = last && last.senderName && c.type === 'group' ? escapeHtml(last.senderName) + ': ' : '';
    const av = c.hasPhoto && c.peer
      ? `<span class="avatar"><img src="${API}/avatar/${c.peer.id}" alt=""></span>`
      : c.type === 'group'
        ? `<span class="avatar">👥</span>`
        : `<span class="avatar">${escapeHtml((c.title || '?')[0].toUpperCase())}</span>`;
    return `<div class="chat-item ${currentChat && currentChat.id === c.id ? 'active' : ''}" onclick="openChat(${c.id})">
      ${av}
      <div class="info">
        <div class="top"><span class="title">${escapeHtml(c.title)}</span><span class="time">${last ? fmtTime(last.createdAt) : ''}</span></div>
        <div class="preview">${senderPrefix}${escapeHtml(preview)}</div>
      </div>
      <div class="right">${c.unread ? `<span class="unread-badge">${c.unread}</span>` : ''}</div>
    </div>`;
  }).join('');
}
function openChat(id) {
  const c = conversations.find((x) => x.id === id);
  if (!c) return;
  currentChat = c;
  replyTo = null;
  $('reply-preview').classList.add('hidden');
  $('chat-empty').classList.add('hidden');
  $('chat-active').classList.remove('hidden');
  $('app-view').classList.add('mobile-chat');
  $('chat-title').textContent = c.title;
  $('chat-avatar').outerHTML = c.hasPhoto && c.peer
    ? `<span class="avatar" id="chat-avatar"><img src="${API}/avatar/${c.peer.id}" alt=""></span>`
    : `<span class="avatar" id="chat-avatar">${escapeHtml((c.title || '?')[0].toUpperCase())}</span>`;
  $('add-member-btn').style.display = c.type === 'group' ? '' : 'none';
  updateChatStatus();
  currentMessages = [];
  loadMessages(true);
  renderChatList();
}
function closeChat() {
  currentChat = null;
  $('app-view').classList.remove('mobile-chat');
  $('chat-active').classList.add('hidden');
  $('chat-empty').classList.remove('hidden');
  renderChatList();
}
async function updateChatStatus() {
  if (!currentChat) return;
  if (currentChat.type === 'dm' && currentChat.peer) {
    try {
      const d = await api('/users/' + currentChat.peer.id);
      currentChat.peer = d.user;
      $('chat-status').textContent = lastSeenText(d.user);
    } catch (e) {}
  } else {
    try {
      const d = await api(`/conversations/${currentChat.id}/members`);
      $('chat-status').textContent = d.members.map((m) => m.displayName).join(', ');
    } catch (e) {}
  }
}

// ---------------- Messages ----------------
async function loadMessages(initial) {
  if (!currentChat) return;
  const search = $('chat-search-input').value.trim();
  try {
    const d = await api(`/conversations/${currentChat.id}/messages?limit=100${search ? '&q=' + encodeURIComponent(search) : ''}`);
    const fresh = d.messages;
    const lastKnown = currentMessages.length ? currentMessages[currentMessages.length - 1].id : 0;
    const hasNew = fresh.some((m) => m.id > lastKnown);
    currentMessages = fresh;
    renderMessages();
    if (hasNew || initial) {
      const el = $('messages');
      el.scrollTop = el.scrollHeight;
    }
    if (currentChat) {
      api(`/conversations/${currentChat.id}/read`, { method: 'POST' }).catch(() => {});
      refreshConversationsSoon();
    }
  } catch (e) { /* ignore transient */ }
}
let refreshSoon = null;
function refreshConversationsSoon() {
  clearTimeout(refreshSoon);
  refreshSoon = setTimeout(refreshConversations, 800);
}
function renderMessages() {
  const el = $('messages');
  let html = '';
  let lastDay = '';
  for (const m of currentMessages) {
    const day = fmtDay(m.createdAt);
    if (day !== lastDay) {
      html += `<div class="day-sep"><span>${day}</span></div>`;
      lastDay = day;
    }
    const mine = m.senderId === me.id;
    const ticks = m.ticks === 'read' ? '<span class="ticks read">✓✓</span>'
      : m.ticks === 'delivered' ? '<span class="ticks">✓✓</span>'
      : m.ticks === 'sent' ? '<span class="ticks">✓</span>' : '';
    let inner = '';
    if (m.deletedForAll) {
      inner = '<span class="deleted">🚫 This message was deleted</span>';
    } else {
      if (currentChat.type === 'group' && !mine) {
        inner += `<div class="sender">${escapeHtml(m.senderName)}</div>`;
      }
      if (m.replyTo) {
        inner += `<div class="reply-box"><div class="r-name">${escapeHtml(m.replyTo.senderName || '')}</div><div>${escapeHtml(replySnippet(m.replyTo))}</div></div>`;
      }
      if (m.kind === 'image' && m.hasMedia) {
        inner += `<img class="media" src="${API}/media/${m.id}?token=${token}" alt="photo" onclick="window.open(this.src,'_blank')">`;
      } else if (m.kind === 'video' && m.hasMedia) {
        inner += `<video class="media" controls src="${API}/media/${m.id}?token=${token}"></video>`;
      } else if (m.kind === 'audio' && m.hasMedia) {
        inner += `<audio controls src="${API}/media/${m.id}?token=${token}"></audio>`;
      }
      if (m.body) inner += `<span>${escapeHtml(m.body)}</span>`;
    }
    // De-duplicate reaction chips per emoji (count shown once).
    const seen = new Set();
    const chips = (m.reactions || []).filter((r) => {
      if (seen.has(r.emoji)) return false;
      seen.add(r.emoji); return true;
    }).map((r) => {
      const n = (m.reactions || []).filter((x) => x.emoji === r.emoji).length;
      return `<span class="reaction-chip ${r.userId === me.id ? 'mine' : ''}" onclick="reactTo(${m.id},'${r.emoji}')">${r.emoji} ${n}</span>`;
    }).join('');
    html += `<div class="msg ${mine ? 'out' : 'in'}" data-id="${m.id}">
      <div class="bubble">${inner}
        <span class="meta">${fmtTime(m.createdAt)} ${mine ? ticks : ''}</span>
        ${chips ? `<div class="reactions">${chips}</div>` : ''}
      </div>
      <div class="msg-actions">
        <button title="Reply" onclick="setReply(${m.id})">↩️</button>
        <button title="React" onclick="openReactPicker(event, ${m.id})">😀</button>
        <button title="Delete" onclick="deleteMessage(${m.id})">🗑️</button>
      </div>
    </div>`;
  }
  el.innerHTML = html || '<p style="text-align:center;color:#667781;margin-top:20px">No messages yet — say hi! 👋</p>';
}
function replySnippet(r) {
  if (!r) return '';
  if (r.body) return r.body;
  return r.kind === 'image' ? '📷 Photo' : r.kind === 'video' ? '🎥 Video' : r.kind === 'audio' ? '🎤 Voice note' : '';
}
function setReply(id) {
  const m = currentMessages.find((x) => x.id === id);
  if (!m) return;
  replyTo = m;
  $('reply-name').textContent = m.senderId === me.id ? 'Yourself' : m.senderName;
  $('reply-text').textContent = m.deletedForAll ? 'Deleted message' : (m.body || replySnippet(m));
  $('reply-preview').classList.remove('hidden');
  $('msg-input').focus();
}
function cancelReply() { replyTo = null; $('reply-preview').classList.add('hidden'); }
async function sendText() {
  const input = $('msg-input');
  const text = input.value.trim();
  if (!text || !currentChat) return;
  input.value = '';
  autoGrow();
  try {
    await api(`/conversations/${currentChat.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: text, kind: 'text', replyTo: replyTo ? replyTo.id : null }),
    });
    cancelReply();
    loadMessages(false);
  } catch (e) { alert('Could not send: ' + e.message); }
}
function composerKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
}
function autoGrow() {
  const el = $('msg-input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
function onTyping() {
  autoGrow();
  const now = Date.now();
  if (currentChat && now - lastTypingSent > 2500) {
    lastTypingSent = now;
    api(`/conversations/${currentChat.id}/typing`, { method: 'POST' }).catch(() => {});
  }
}
async function sendMediaFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || !currentChat) return;
  if (file.size > 12 * 1024 * 1024) { alert('File too large (max 12 MB)'); return; }
  const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : null;
  if (!kind) { alert('Please choose a photo or video'); return; }
  const b64 = await fileToBase64(file);
  try {
    await api(`/conversations/${currentChat.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ kind, mediaBase64: b64.split(',')[1], mediaMime: file.type, mediaName: file.name, body: '' }),
    });
    loadMessages(false);
  } catch (e) { alert('Could not send: ' + e.message); }
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
async function reactTo(id, emoji) {
  try {
    await api(`/messages/${id}/react`, { method: 'POST', body: JSON.stringify({ emoji }) });
    loadMessages(false);
  } catch (e) {}
}
async function deleteMessage(id) {
  const m = currentMessages.find((x) => x.id === id);
  if (!m) return;
  const mode = m.senderId === me.id
    ? (confirm('Delete for everyone? OK = everyone, Cancel = just for me') ? 'everyone' : 'me')
    : 'me';
  try {
    await api(`/messages/${id}/delete`, { method: 'POST', body: JSON.stringify({ mode }) });
    loadMessages(false);
  } catch (e) { alert('Could not delete: ' + e.message); }
}
function toggleChatSearch() {
  $('chat-search-box').classList.toggle('hidden');
  if (!$('chat-search-box').classList.contains('hidden')) $('chat-search-input').focus();
  else { $('chat-search-input').value = ''; loadMessages(true); }
}

// ---------------- Voice notes ----------------
async function toggleRecording() {
  const btn = $('mic-btn');
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    btn.classList.remove('recording');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) recordingChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recordingChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (!currentChat) return;
      const b64 = await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.readAsDataURL(blob);
      });
      try {
        await api(`/conversations/${currentChat.id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ kind: 'audio', mediaBase64: b64.split(',')[1], mediaMime: blob.type, mediaName: 'voice-note.webm', body: '' }),
        });
        loadMessages(false);
      } catch (e) { alert('Could not send voice note: ' + e.message); }
    };
    mediaRecorder.start();
    btn.classList.add('recording');
  } catch (e) {
    alert('Microphone not available: ' + e.message);
  }
}

// ---------------- Emoji picker ----------------
const EMOJIS = ['😀', '😂', '❤️', '👍', '🙏', '😮', '😢', '😡', '🎉', '🔥', '👏', '😊'];
function toggleEmojiPicker(e) {
  e.stopPropagation();
  closeEmojiPicker();
  const root = $('emoji-pop-root');
  const div = document.createElement('div');
  div.className = 'emoji-pop left';
  div.id = 'emoji-pop';
  div.innerHTML = EMOJIS.map((em) => `<button onclick="insertEmoji('${em}')">${em}</button>`).join('');
  root.appendChild(div);
  setTimeout(() => document.addEventListener('click', closeEmojiPicker, { once: true }), 0);
}
function closeEmojiPicker() {
  const p = $('emoji-pop');
  if (p) p.remove();
}
function insertEmoji(em) {
  $('msg-input').value += em;
  closeEmojiPicker();
  $('msg-input').focus();
}
function openReactPicker(e, id) {
  e.stopPropagation();
  closeEmojiPicker();
  const root = $('emoji-pop-root');
  const div = document.createElement('div');
  div.className = 'emoji-pop';
  div.id = 'emoji-pop';
  div.style.left = '12px';
  div.innerHTML = EMOJIS.map((em) => `<button onclick="reactTo(${id},'${em}');closeEmojiPicker()">${em}</button>`).join('');
  root.appendChild(div);
  setTimeout(() => document.addEventListener('click', closeEmojiPicker, { once: true }), 0);
}

// ---------------- Modals ----------------
function openModal(title, bodyHtml, footerHtml) {
  $('modal-root').innerHTML = `<div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
    <div class="modal"><header><span>${title}</span><button onclick="closeModal()">✕</button></header>
    <div class="body">${bodyHtml}</div>${footerHtml ? `<footer>${footerHtml}</footer>` : ''}</div></div>`;
}
function closeModal() { $('modal-root').innerHTML = ''; }
async function openNewChat() {
  openModal('New chat', '<input type="text" id="user-search" placeholder="Search people…" oninput="listUsers(this.value)"><div id="user-list" style="margin-top:8px">Loading…</div>', '');
  listUsers('');
}
async function listUsers(q) {
  try {
    const d = await api('/users' + (q ? '?q=' + encodeURIComponent(q) : ''));
    $('user-list').innerHTML = d.users.length
      ? d.users.map((u) => `<div class="user-row" onclick="startDm(${u.id})">${avatarHtml(u)}<div class="nm"><div class="t">${escapeHtml(u.displayName)}</div><div class="s">@${escapeHtml(u.username)}</div></div></div>`).join('')
      : '<p style="color:#667781;text-align:center;padding:12px">No people found yet — ask a friend to sign up!</p>';
  } catch (e) { $('user-list').innerHTML = 'Could not load users.'; }
}
async function startDm(userId) {
  try {
    const d = await api('/conversations/dm', { method: 'POST', body: JSON.stringify({ userId }) });
    closeModal();
    await refreshConversations();
    openChat(d.conversationId);
  } catch (e) { alert(e.message); }
}
async function openNewGroup() {
  openModal('New group',
    '<label>Group name</label><input type="text" id="group-name" placeholder="e.g. Family ❤️" maxlength="40"><label style="margin-top:12px">Add members</label><div id="group-user-list">Loading…</div>',
    '<button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="createGroup()">Create group</button>');
  try {
    const d = await api('/users');
    $('group-user-list').innerHTML = d.users.length
      ? d.users.map((u) => `<label class="user-row"><input type="checkbox" value="${u.id}">${avatarHtml(u)}<div class="nm"><div class="t">${escapeHtml(u.displayName)}</div><div class="s">@${escapeHtml(u.username)}</div></div></label>`).join('')
      : '<p style="color:#667781;text-align:center;padding:12px">No other people yet.</p>';
  } catch (e) {}
}
async function createGroup() {
  const name = $('group-name').value.trim();
  const memberIds = [...document.querySelectorAll('#group-user-list input[type=checkbox]:checked')].map((c) => parseInt(c.value, 10));
  if (!name) { alert('Please enter a group name'); return; }
  try {
    const d = await api('/conversations/group', { method: 'POST', body: JSON.stringify({ name, memberIds }) });
    closeModal();
    await refreshConversations();
    openChat(d.conversationId);
  } catch (e) { alert(e.message); }
}
async function openAddMember() {
  if (!currentChat || currentChat.type !== 'group') return;
  openModal('Add members', '<input type="text" placeholder="Search people…" oninput="listAddUsers(this.value)"><div id="user-list" style="margin-top:8px">Loading…</div>', '');
  listAddUsers('');
}
async function listAddUsers(q) {
  try {
    const d = await api('/users' + (q ? '?q=' + encodeURIComponent(q) : ''));
    const members = await api(`/conversations/${currentChat.id}/members`);
    const memberIds = new Set(members.members.map((m) => m.id));
    const candidates = d.users.filter((u) => !memberIds.has(u.id));
    $('user-list').innerHTML = candidates.length
      ? candidates.map((u) => `<div class="user-row" onclick="addMember(${u.id})">${avatarHtml(u)}<div class="nm"><div class="t">${escapeHtml(u.displayName)}</div><div class="s">@${escapeHtml(u.username)}</div></div></div>`).join('')
      : '<p style="color:#667781;text-align:center;padding:12px">Everyone is already in this group.</p>';
  } catch (e) {}
}
async function addMember(userId) {
  try {
    await api(`/conversations/${currentChat.id}/members`, { method: 'POST', body: JSON.stringify({ userId }) });
    closeModal();
    updateChatStatus();
  } catch (e) { alert(e.message); }
}
function openChatInfo() {
  if (!currentChat) return;
  if (currentChat.type === 'dm' && currentChat.peer) {
    openModal(escapeHtml(currentChat.peer.displayName),
      `<p style="color:#667781">@${escapeHtml(currentChat.peer.username)}</p><p style="margin-top:8px">${escapeHtml(currentChat.peer.about || 'No about text yet.')}</p><p style="margin-top:8px;color:#667781;font-size:13px">${lastSeenText(currentChat.peer)}</p>`,
      '<button class="btn primary" onclick="closeModal()">Close</button>');
  } else {
    openModal(escapeHtml(currentChat.title), '<div id="info-members">Loading…</div>',
      '<button class="btn primary" onclick="closeModal()">Close</button>');
    api(`/conversations/${currentChat.id}/members`).then((d) => {
      $('info-members').innerHTML = d.members.map((m) => `<div class="user-row">${avatarHtml(m)}<div class="nm"><div class="t">${escapeHtml(m.displayName)}</div><div class="s">@${escapeHtml(m.username)}</div></div></div>`).join('');
    }).catch(() => {});
  }
}
function openProfile() {
  openModal('My profile',
    `<label>Display name</label><input type="text" id="prof-name" value="${escapeHtml(me.displayName)}" maxlength="40">
     <label>About</label><input type="text" id="prof-about" value="${escapeHtml(me.about || '')}" maxlength="140" placeholder="Hey there! I am using Zyad Chat.">
     <label>Profile photo</label><input type="file" id="prof-photo" accept="image/*" style="margin-top:4px">`,
    '<button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveProfile()">Save</button>');
}
async function saveProfile() {
  const displayName = $('prof-name').value.trim();
  const about = $('prof-about').value;
  const file = $('prof-photo').files && $('prof-photo').files[0];
  let photoBase64 = null, photoMime = null;
  if (file) {
    const b64 = await fileToBase64(file);
    photoBase64 = b64.split(',')[1];
    photoMime = file.type;
  }
  try {
    const d = await api('/me/profile', { method: 'PUT', body: JSON.stringify({ displayName, about, photoBase64, photoMime }) });
    me = d.user;
    $('me-name').textContent = me.displayName;
    $('me-avatar').outerHTML = avatarHtml(me, '', 'me-avatar');
    closeModal();
  } catch (e) { alert('Could not save: ' + e.message); }
}

// ---------------- Polling ----------------
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    refreshConversations();
    if (currentChat) {
      loadMessages(false);
      updateChatStatus();
      api(`/conversations/${currentChat.id}/typing`).then((d) => {
        const el = $('typing-indicator');
        if (d.typing && d.typing.length) {
          el.textContent = d.typing.map((t) => t.displayName).join(', ') + (d.typing.length > 1 ? ' are typing…' : ' is typing…');
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      }).catch(() => {});
    }
    api('/me/heartbeat', { method: 'POST' }).catch(() => {});
  }, 3000);
}

// ---------------- Boot ----------------
(async function init() {
  if (!token) return;
  try {
    const d = await api('/me');
    afterAuth({ token, user: d.user });
  } catch (e) {
    localStorage.removeItem('zyadchat_token');
    token = null;
  }
})();
