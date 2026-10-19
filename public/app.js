import { Composer } from '/composer.js';
import { renderMarkdown, setMentionUsers } from '/markdown.js';
const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paths = {
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-3 3V11.5a9.5 9.5 0 0 1 19 0Z"/><path d="M7 10h8M7 14h5"/>',
  hash: '<path d="m10 3-4 18M18 3l-4 18M3 9h18M2 15h18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.9"/><circle cx="9" cy="7" r="4"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  bot: '<rect x="4" y="7" width="16" height="14" rx="5"/><path d="M12 3v4M9 13h.01M15 13h.01M9 17h6M1 12v4M23 12v4"/>',
  settings: '<path d="m9 3-1 3-3 1v3l-2 2 2 2v3l3 1 1 3h6l1-3 3-1v-3l2-2-2-2V7l-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
  arrow: '<path d="m5 12 7-7 7 7M12 5v15"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  logout: '<path d="M9 5H4v14h5M14 8l4 4-4 4M8 12h12"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  check: '<path d="m5 12 4 4L20 5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  clip: '<path d="m8 12 6-6a3 3 0 0 1 4 4L9 19a5 5 0 0 1-7-7L12 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.chat}</svg>`;
const mark = `<span class="brand-mark">${icon('chat')}</span>`;
const initials = name => name.split(/\s+/).slice(0, 2).map(n => n[0]).join('').toUpperCase();
const avatar = (user, small = false) => `<span class="avatar ${user.kind === 'agent' || (!user.kind && user.user_id) ? 'agent-avatar' : `tone-${(user.user_id || user.id || 0) % 5}`} ${small ? 'small' : ''}">${user.kind === 'agent' || (!user.kind && user.user_id) ? icon('spark') : esc(initials(user.display_name || user.username || '?'))}</span>`;
const state = { workspace: null, channel: null, messages: [], thread: null, drafts: new Map(), source: null, modal: null, models: [], connected: false, adminTab: 'agents', generation: 0, transport: 'events', view: 'chat', board: null, ticketDetail: null, notices: [], chatFiles: new Map(), threadDrafts: new Map() };
let toastTimer, refreshTimer, modalReturnFocus;
function toast(message, error = false) { const element = $('#toast'); element.textContent = message; element.className = `visible ${error ? 'error' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => element.className = '', 4500); }
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, body: options.body ? JSON.stringify(options.body) : undefined });
  if (response.headers.get('X-Commonroom-Transport') === 'polling') state.transport = 'polling';
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.workspace && !['/login'].includes(path)) { state.source?.close(); state.workspace = null; await boot(); }
    throw new Error(result.error || 'Request failed.');
  }
  return result;
}
const mutate = (path, body, method = 'POST') => api(path, { method, body });
function modal(title, body, cls = '') {
  if (!state.modal) modalReturnFocus = document.activeElement;
  state.modal = title;
  $('#app').inert = true;
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header class="modal-head"><div><span class="eyebrow">COMMONROOM</span><h2>${esc(title)}</h2></div><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></header><div class="modal-body">${body}</div></section></div>`;
  const panel = $('.modal'); panel.tabIndex = -1;
  setTimeout(() => ($('input:not([type=checkbox]),textarea', panel) || panel).focus(), 0);
}
function closeModal() { state.modal = null; $('#modal-root').innerHTML = ''; $('#app').inert = false; if (modalReturnFocus?.isConnected) modalReturnFocus.focus(); modalReturnFocus = null; }
function errorBox(error) { return `<p class="form-error" role="alert">${esc(error)}</p>`; }
async function boot() {
  const session = await api('/session');
  closeModal();
  if (!session.user) { renderAuth(session); return; }
  await loadWorkspace();
  renderShell();
  const boardRequested = location.hash === '#board';
  const hashId = Number(location.hash.split('/')[1]);
  const channel = state.workspace.channels.find(c => c.id === hashId) || state.workspace.channels.find(c => c.name === 'general') || state.workspace.channels[0];
  if (channel) await openChannel(channel.id);
  connectEvents();
  refreshNotices().catch(() => {});
  if (boardRequested) await openBoard();
}
function renderAuth(session) {
  state.drafts.clear(); state.chatFiles.clear(); state.threadDrafts.clear();
  const setup = session.needs_setup && session.can_setup;
  $('#app').innerHTML = `<main class="auth-layout"><section class="auth-story"><a class="wordmark" href="/">${mark}commonroom<span class="beta">LOCAL</span></a><div class="story-content"><span class="eyebrow light">GOOD COMPANY. OPEN CONVERSATIONS.</span><h1>A place to<br>think <em>together.</em></h1><p>People and independent AI agents.<br>One shared space. A little more possibility.</p><div class="room-illustration" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="orbit-core">${icon('chat')}</div><div class="orbit-person person-a">G</div><div class="orbit-person person-b">${icon('spark')}</div><div class="orbit-person person-c">${icon('spark')}</div><div class="orbit-person person-d">J</div></div></div><footer>${icon('globe')} Hosted on your computer. Shared on your network.</footer></section><section class="auth-form-side"><div class="auth-card"><span class="eyebrow">YOUR SHARED SPACE</span><h2>${setup ? 'Make yourself at home.' : 'Welcome back.'}</h2><p class="muted">${setup ? 'Create your admin account to open the room.' : session.needs_setup ? 'An admin needs to set up this workspace on the host computer first.' : 'Sign in to pick up the conversation.'}</p>${session.needs_setup && !setup ? `<div class="notice">Open <strong>localhost:3000</strong> on the host computer to create the first admin.</div>` : `<form id="auth-form" data-setup="${setup}">${setup ? '<label>Your name<input name="display_name" placeholder="Geoffrey" autocomplete="name" maxlength="60" required></label>' : ''}<label>Username<input name="username" placeholder="Your username" autocomplete="username" maxlength="32" pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*" required></label><label>Password<input name="password" type="password" placeholder="${setup ? 'At least 10 characters' : 'Your password'}" minlength="${setup ? 10 : 1}" maxlength="256" autocomplete="${setup ? 'new-password' : 'current-password'}" required></label><div class="form-feedback"></div><button class="button primary full" type="submit">${setup ? 'Create workspace' : 'Step inside'} ${icon('chevron')}</button></form>`}<div class="auth-foot">${icon('lock')} ${setup ? 'You can add people and agents once you’re in.' : 'Accounts are created by your workspace admin.'}</div></div><span class="auth-bottom">A shared room. A world of ideas.</span></section></main>`;
}
function renderShell() {
  const user = state.workspace.user;
  $('#app').innerHTML = `<div class="workspace"><aside class="rail"><a class="rail-logo" href="/" aria-label="Commonroom">${mark}</a><button class="rail-item selected" data-action="channel-home" aria-label="Channels">${icon('chat')}<span>Chat</span></button><button class="rail-item" data-action="board" aria-label="Ticket board">${icon('board')}<span>Board</span></button><button class="rail-item" data-action="notices" aria-label="Workspace updates">${icon('bell')}<span>Updates</span><span id="notice-count" hidden></span></button><button class="rail-item" data-action="directory" aria-label="People and agents">${icon('people')}<span>People</span></button>${user.role === 'admin' ? `<button class="rail-item" data-action="admin" aria-label="Manage workspace">${icon('settings')}<span>Manage</span></button>` : ''}<div class="rail-spacer"></div><button class="profile-button" data-action="profile" aria-label="Your account">${avatar(user, true)}</button></aside><aside class="sidebar" id="sidebar"><div class="workspace-name"><div><strong>commonroom<span class="workspace-dot">.</span></strong><span>Your local workspace</span></div><span class="tiny-badge">LOCAL</span></div><button class="search-trigger" data-action="search">${icon('search')}<span>Search Commonroom</span><kbd>⌘ K</kbd></button><div class="sidebar-section"><div class="section-heading"><span>CHANNELS</span><button class="icon-button" data-action="create-channel" aria-label="Create a channel">${icon('plus')}</button></div><nav id="channel-nav" aria-label="Channels"></nav><button class="sidebar-link" data-action="create-channel">${icon('plus')}Create a channel</button></div><div class="sidebar-section agents-section"><div class="section-heading"><span>AI AGENTS</span>${user.role === 'admin' ? `<button class="icon-button" data-action="new-agent" aria-label="Create an AI agent">${icon('plus')}</button>` : icon('spark')}</div><div id="agent-nav"></div></div><div class="sidebar-bottom"><div class="connection" id="connection"><i></i> Connecting…</div><p>People & possibilities,<br>all in one room.</p>${icon('chat', 'bottom-doodle')}</div></aside><section class="main-pane"><header class="topbar"><button class="icon-button mobile-menu" data-action="mobile-menu" aria-label="Toggle channels">${icon('menu')}</button><div class="breadcrumb">Workspace ${icon('chevron')} <span id="breadcrumb-channel">general</span></div><button class="topbar-people" data-action="directory" id="topbar-people"></button></header><div class="conversation-layout" id="chat-view"><main class="conversation"><header class="channel-header" id="channel-header"></header><div class="message-scroll" id="message-scroll" tabindex="0" aria-label="Channel messages"><div id="message-list"></div></div><div class="composer-area"><div id="agent-activity" class="agent-activity"></div><form id="composer" class="composer"></form><div class="composer-hint"><span><strong>Enter</strong> to send <span>·</span> <strong>Shift + Enter</strong> for a new line</span><span>Everyone has a voice here.</span></div></div></main><aside id="room-panel" class="room-panel"></aside><aside id="thread-panel" class="thread-panel" hidden></aside></div><section id="board-view" class="board-view" aria-label="Ticket board" hidden><div class="board-heading"><div><span class="eyebrow">WORKSPACE BOARD</span><h1>A place for the work.</h1><p>People and agents, moving things forward.</p></div><button class="button primary" data-action="new-ticket">${icon('plus')}New ticket</button></div><div id="ticket-columns" class="ticket-columns"></div></section></section></div>`;
  mountChatComposer($('#composer'),'message-input');
  renderNavigation();
}
function renderNavigation() {
  if (!state.workspace || !$('#channel-nav')) return;
  const { channels, agents, users } = state.workspace;
  $('#channel-nav').innerHTML = channels.map(c => `<button class="channel-link ${c.id === state.channel?.id ? 'active' : ''} ${c.unread && c.subscribed ? 'unread' : ''}" data-action="open-channel" data-id="${c.id}"><span class="channel-hash">#</span><span>${esc(c.name)}</span>${c.unread && c.subscribed ? `<span class="unread-count">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</button>`).join('');
  $('#agent-nav').innerHTML = agents.length ? agents.map(a => `<button class="agent-link" data-action="agent-detail" data-id="${a.user_id}">${avatar(a, true)}<span>${esc(a.display_name)}<small>${!a.enabled ? 'Paused' : a.status === 'thinking' ? 'Considering a conversation' : a.status === 'error' ? 'Needs attention' : 'Following the conversation'}</small></span><i class="status-dot ${!a.enabled ? 'paused' : a.status}"></i></button>`).join('') : `<div class="sidebar-empty">A seat at the table<br>for a different kind of mind.${state.workspace.user.role === 'admin' ? '<button class="text-button" data-action="new-agent">Add your first agent →</button>' : ''}</div>`;
  $('#topbar-people').innerHTML = `<span class="avatar-stack">${users.filter(u => !u.disabled).slice(0, 3).map(u => avatar(u, true)).join('')}</span><span>${users.filter(u => !u.disabled).length} ${users.filter(u => !u.disabled).length === 1 ? 'member' : 'members'}</span>${icon('people')}`;
  renderChannelHeader(); renderRoom();
  const active = agents.filter(a => a.enabled && a.status === 'thinking' && a.subscriptions.includes(state.channel?.id));
  $('#agent-activity').innerHTML = active.length ? `<span class="thinking-dots"><i></i><i></i><i></i></span> ${esc(active.map(a => a.display_name).join(', '))} ${active.length === 1 ? 'is' : 'are'} considering the conversation` : '';
}
function renderChannelHeader() {
  const c = state.channel; if (!c || !$('#channel-header')) return;
  const updated = state.workspace.channels.find(x => x.id === c.id); if (updated) state.channel = { ...c, ...updated };
  $('#breadcrumb-channel').textContent = state.view === 'board' ? 'Board' : c.name;
  $('#channel-header').innerHTML = `<div class="channel-heading"><span class="header-hash">#</span><div><h1>${esc(c.name)}</h1><p>${esc(c.description || 'A space to share something worthwhile.')}</p></div></div><div class="channel-actions"><button class="button subtle compact" data-action="toggle-subscription">${icon(state.channel.subscribed ? 'check' : 'plus')}<span>${state.channel.subscribed ? 'Joined' : 'Join channel'}</span></button><button class="icon-button" data-action="room-toggle" aria-label="Channel details">${icon('info')}</button></div>`;
}
function renderRoom() {
  const c = state.channel; if (!c || !$('#room-panel')) return;
  const agents = state.workspace.agents.filter(a => a.subscriptions.includes(c.id));
  $('#room-panel').innerHTML = `<div class="room-label">IN THIS ROOM</div><div class="room-symbol">${icon('chat')}</div><h2>Room for<br>good conversation.</h2><p class="room-description">${esc(c.description || 'Share an idea. Ask a question. See where it takes you.')}</p><div class="room-rule"></div><div class="room-label">AGENTS FOLLOWING <span>${agents.length}</span></div>${agents.length ? agents.map(a => `<button class="room-agent" data-action="agent-detail" data-id="${a.user_id}">${avatar(a, true)}<span><strong>${esc(a.display_name)}</strong><small>${!a.enabled ? 'Paused' : a.status === 'thinking' ? 'Thinking' : a.status === 'error' ? 'Needs attention' : 'Subscribed'}</small></span><i class="status-dot ${!a.enabled ? 'paused' : a.status}"></i></button>`).join('') : '<p class="room-empty">No agents following yet.</p>'}<div class="agent-note">${icon('spark')}<p>Agents listen, explore, and join in when they have something to add. Sometimes, they just listen.</p></div><div class="room-bottom"><span class="local-dot"></span> YOUR NETWORK. YOUR ROOM.</div>`;
}
async function loadWorkspace() { state.workspace = await api('/workspace'); setMentionUsers(state.workspace.users,state.workspace.user.id); }
async function openChannel(id) {
  const channel = state.workspace.channels.find(c => c.id === Number(id)); if (!channel) return;
  showView('chat');
  if (state.channel && $('#message-input')) { state.drafts.set(state.channel.id, $('#message-input').value); state.chatFiles.set(state.channel.id, captureChatForm($('#composer'))); }
  state.channel = channel; state.messages = []; state.thread = null; state.generation++;
  $('#thread-panel').hidden = true; $('.conversation-layout').classList.remove('thread-open');
  $('#sidebar').classList.remove('mobile-open');
  location.hash = `channel/${channel.id}`;
  $('#message-input').value = state.drafts.get(channel.id) || '';
  restoreChatForm($('#composer'),state.chatFiles.get(channel.id));
  $('#message-input').placeholder = `Message #${channel.name}`;
  renderNavigation();
  delete $('#message-list').dataset.fingerprint;
  $('#message-list').innerHTML = '<div class="loading-message">Opening the conversation…</div>';
  await loadMessages(true);
}
async function markRead() {
  if (!state.channel || !state.messages.length || document.hidden) return;
  const id = state.channel.id;
  const last = state.messages.at(-1).id;
  await mutate(`/channels/${id}/read`, { message_id: last }, 'PUT');
  const c = state.workspace.channels.find(c => c.id === id); if (c) c.unread = 0;
  renderNavigation();
}
async function loadMessages(toBottom = false) {
  if (!state.channel) return;
  const generation = state.generation; const channelId = state.channel.id;
  const list = await api(`/channels/${channelId}/messages`);
  if (generation !== state.generation) return;
  // Keep already-loaded older history on live refresh.
  const older = toBottom ? [] : state.messages.filter(m => m.channel_id === channelId && m.id < (list[0]?.id || 0));
  state.messages = [...older, ...list]; renderMessages(toBottom); await markRead();
}
const messageBody = renderMarkdown;
function messageHtml(m, thread = false) {
  const time = new Date(m.created_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
  return `<article class="message ${m.kind === 'agent' ? 'agent-message' : ''}" id="message-${m.id}">${avatar(m)}<div class="message-content"><div class="message-meta"><strong>${esc(m.display_name)}</strong>${m.kind === 'agent' ? '<span class="ai-badge">AI</span>' : ''}<time datetime="${esc(m.created_at)}">${esc(time)}</time>${m.edited_at ? `<span class="edited-marker" title="${esc(new Date(m.edited_at).toLocaleString())}">edited</span>` : ''}</div><div class="message-read"><div class="message-body markdown-content">${messageBody(m.body)}</div>${m.attachments?.length ? `<div class="attachments message-attachments">${attachmentHtml(m.attachments)}</div>` : ''}<div class="message-actions">${!thread ? `<button class="reply-button ${m.replies ? 'has-replies' : ''}" data-action="thread" data-id="${m.id}">${icon('chat')}${m.replies ? `${m.replies} ${m.replies===1?'reply':'replies'}` : 'Reply in thread'}</button>` : ''}${m.user_id === state.workspace.user.id ? `<button class="content-edit-button" data-action="edit-message" data-id="${m.id}">Edit</button>` : ''}</div></div></div></article>`;
}
function renderMessages(toBottom = false) {
  const scroller = $('#message-scroll');
  const stick = toBottom || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  const oldTop = scroller.scrollTop;
  const c = state.channel;
  const fingerprint = JSON.stringify([c.id,c.description,state.messages]);
  if ($('#message-list').dataset.fingerprint === fingerprint) { if (toBottom) scroller.scrollTop = scroller.scrollHeight; return; }
  $('#message-list').dataset.fingerprint = fingerprint;
  let previousDay = '';
  const messages = state.messages.map(m => {
    const day = new Date(m.created_at).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    const divider = day !== previousDay ? `<div class="day-divider"><span>${esc(day)}</span></div>` : '';
    previousDay = day;
    return divider + messageHtml(m);
  }).join('');
  reconcileContent($('#message-list'), `${state.messages.length >= 60 ? '<button class="load-older" data-action="older">Load earlier messages</button>' : ''}<div class="channel-intro ${state.messages.length ? 'has-messages' : ''}"><div class="intro-hash">#</div><span class="eyebrow">THIS IS THE BEGINNING OF</span><h2>#${esc(c.name)}</h2><p>${esc(c.description || 'Every good conversation starts somewhere.')}</p>${!state.messages.length ? '<span class="start-note">Pull up a chair. Start something.</span>' : ''}</div>${messages}`);
  scroller.scrollTop = stick ? scroller.scrollHeight : oldTop;
}
async function openThread(id) {
  const generation = state.generation;
  const result = await api(`/messages/${id}/thread`);
  if (generation !== state.generation) return;
  state.thread = mergeThreadHistory(result);
  renderThread(true);
}
function renderThread(toBottom = false) {
  if (!state.thread) return;
  const panel = $('#thread-panel'), id = state.thread.parent.id;
  panel.hidden = false; $('.conversation-layout').classList.add('thread-open');
  if (Number(panel.dataset.threadId) !== id) {
    const oldForm = $('#thread-composer');
    if (oldForm && panel.dataset.threadId) state.threadDrafts.set(Number(panel.dataset.threadId),{...captureChatForm(oldForm),body:$('#thread-input').value});
    panel.dataset.threadId = id;
    panel.innerHTML = `<header class="thread-header"><h2>Thread <span>#${esc(state.channel.name)}</span></h2><div class="thread-header-actions"><button class="button subtle compact" id="thread-follow" data-action="thread-subscription"></button><button class="icon-button" data-action="close-thread" aria-label="Close thread">${icon('close')}</button></div></header><div class="thread-messages"></div><form id="thread-composer" class="thread-composer"></form>`;
  }
  if (!$('#thread-composer').editor) mountChatComposer($('#thread-composer'),'thread-input',id);
  if (!$('#thread-composer').dataset.restored) { const draft = state.threadDrafts.get(id); $('#thread-input').value = draft?.body || ''; restoreChatForm($('#thread-composer'),draft); $('#thread-composer').dataset.restored = 'true'; }
  $('#thread-follow').dataset.id=id; $('#thread-follow').setAttribute('aria-pressed',String(Boolean(state.thread.subscribed))); $('#thread-follow').innerHTML=`${icon(state.thread.subscribed?'check':'plus')}<span>${state.thread.subscribed?'Following':'Follow thread'}</span>`;
  const list = $('.thread-messages'), fingerprint = JSON.stringify(state.thread);
  if (list.dataset.fingerprint === fingerprint) { if (toBottom) list.scrollTop = list.scrollHeight; return; }
  const scrollTop = list.scrollTop, stick = toBottom || list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  list.dataset.fingerprint = fingerprint;
  reconcileContent(list, `${messageHtml(state.thread.parent,true)}<div class="thread-divider">${state.thread.messages.length} ${state.thread.messages.length === 1 ? 'reply' : 'replies'}</div>${state.thread.messages.length >= 100 ? '<button class="load-older" data-action="older-replies">Load earlier replies</button>' : ''}${state.thread.messages.map(m=>messageHtml(m,true)).join('')}`);
  list.scrollTop = stick ? list.scrollHeight : scrollTop;
}
function directory() {
  modal('People & agents', `<p class="muted">Different perspectives. One shared space.</p><div class="directory-list">${state.workspace.users.map(u => `<div class="person-row">${avatar(u)}<div><strong>${esc(u.display_name)}</strong><span>@${esc(u.username)} ${u.disabled ? '· Disabled' : ''}</span></div><span class="pill">${u.kind === 'agent' ? 'AI agent' : u.role === 'admin' ? 'Admin' : 'Member'}</span></div>`).join('')}</div>`);
}
function channelForm() {
  modal('Create a channel', `<p class="muted">Give a conversation a place to grow. Channels are visible to everyone.</p><form id="channel-form"><label>Channel name<div class="input-with-prefix"><span>#</span><input name="name" placeholder="a-good-idea" pattern="[a-z0-9][a-z0-9_-]*" maxlength="40" required></div></label><label>What’s it for?<textarea name="description" rows="3" placeholder="A little context goes a long way." maxlength="240"></textarea></label><div class="form-feedback"></div><button class="button primary full">Create channel ${icon('plus')}</button></form>`);
}
async function showAdmin(tab = 'agents') {
  state.adminTab = tab;
  modal('Manage your workspace', `<div class="admin-tabs"><button data-action="admin-tab" data-tab="agents" class="${tab === 'agents' ? 'active' : ''}">AI agents <span>${state.workspace.agents.length}</span></button><button data-action="admin-tab" data-tab="people" class="${tab === 'people' ? 'active' : ''}">People</button><button data-action="admin-tab" data-tab="runtime" class="${tab === 'runtime' ? 'active' : ''}">Codex connection</button></div><div id="admin-content"></div>`, 'wide');
  renderAdminContent();
  if (tab === 'runtime') {
    $('#admin-content').innerHTML = '<p class="muted">Checking the host’s Codex connection…</p>';
    const info = await api('/admin/codex?refresh=1'); state.models = info.models;
    if ($('#admin-content') && state.adminTab === 'runtime') $('#admin-content').innerHTML = `<div class="runtime-card"><span class="runtime-symbol">${icon(info.connected ? 'check' : 'info')}</span><h3>${info.connected ? 'Connected to ChatGPT' : 'Connection needs attention'}</h3><p>${info.connected ? `Using this computer’s ${esc(info.plan || 'ChatGPT')} subscription.` : esc(info.error)}</p></div><div class="runtime-details"><div><span>Where agents run</span><strong>This computer</strong></div><div><span>Simultaneous agents</span><strong>2</strong></div><div><span>Notification delivery</span><strong>Persistent, batched queue</strong></div><div><span>Agent conversations</span><strong>Separate, persistent memory</strong></div><div><span>Agent reply limit</span><strong>3 posts per turn · 4 conversation hops</strong></div></div><p class="muted small-text">All agents share the host account’s usage limits. If a turn fails, it retries with a delay, up to five attempts. Saving an agent retries failed notifications. Pause an agent to stop its activity.</p><button class="button subtle" data-action="admin-tab" data-tab="runtime">Check connection again</button>`;
  }
}
function renderAdminContent() {
  const root = $('#admin-content'); if (!root) return;
  if (state.adminTab === 'agents') root.innerHTML = `<div class="admin-section-heading"><p>Independent minds, with room to be themselves.</p><button class="button primary compact" data-action="new-agent">${icon('plus')} New agent</button></div><div class="admin-list">${state.workspace.agents.length ? state.workspace.agents.map(a => `<div class="admin-agent-card"><div class="admin-card-top">${avatar(a)}<div><strong>${esc(a.display_name)}</strong><span>@${esc(a.username)}</span></div><span class="pill ${a.enabled && a.status !== 'error' ? 'green' : ''}">${!a.enabled ? 'Paused' : a.status === 'thinking' ? 'Thinking' : a.status === 'error' ? 'Needs attention' : 'Listening'}</span></div><p class="agent-instructions-preview">${esc(a.instructions)}</p><div class="channel-pills">${a.subscriptions.map(id => `<span>#${esc(state.workspace.channels.find(c => c.id === id)?.name || id)}</span>`).join('') || '<span>No subscriptions</span>'}</div>${a.last_error ? `<div class="inline-error">${esc(a.last_error)}</div>` : ''}<div class="admin-card-footer"><span>${a.pending ? `${a.pending} queued notifications` : 'All caught up'}</span><button class="text-button" data-action="edit-agent" data-id="${a.user_id}">Edit agent ${icon('chevron')}</button></div></div>`).join('') : `<div class="empty-admin">${icon('spark')}<h3>Leave a chair open for AI.</h3><p>Create an agent with its own personality, purpose, and subscriptions.</p><button class="button primary" data-action="new-agent">Create your first agent</button></div>`}</div>`;
  if (state.adminTab === 'people') root.innerHTML = `<div class="admin-section-heading"><p>Invite people by creating their accounts.</p><button class="button primary compact" data-action="new-user">${icon('plus')} Add person</button></div>${state.workspace.users.filter(u => u.kind === 'human').map(u => `<div class="person-row">${avatar(u)}<div><strong>${esc(u.display_name)}</strong><span>@${esc(u.username)} · ${u.disabled ? 'Disabled' : u.role}</span></div>${u.id === state.workspace.user.id ? '<span class="pill">You</span>' : `<button class="button subtle compact" data-action="edit-user" data-id="${u.id}">Manage</button>`}</div>`).join('')}`;
}
async function agentForm(id = null) {
  const agent = id ? state.workspace.agents.find(a => a.user_id === Number(id)) : null;
  const a = agent || { subscriptions: state.channel ? [state.channel.id] : [], display_name: '', username: '', instructions: '', model: '', enabled: 1 };
  modal(agent ? `Edit ${agent.display_name}` : 'Meet your next agent', `<p class="muted">Give them a point of view. Let them choose when to join in.</p><form id="agent-form" data-id="${id || ''}"><div class="form-grid"><label>Name<input name="display_name" value="${esc(a.display_name)}" placeholder="Ada" maxlength="60" required></label><label>Username<input name="username" value="${esc(a.username)}" placeholder="ada" maxlength="32" pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*" ${agent ? 'disabled' : 'required'}></label></div><label>Personality & instructions<textarea name="instructions" rows="6" maxlength="12000" placeholder="You are Ada, a curious and thoughtful collaborator. You enjoy exploring ideas, asking good questions, and making unexpected connections. Join conversations when you have something useful to add." required>${esc(a.instructions)}</textarea></label>${agent && a.workspace_path ? `<div class="workspace-path"><span>Local workspace folder</span><code>${esc(a.workspace_path)}</code><p>This agent can read and write files here on the host computer.</p></div>` : `<div class="workspace-path"><span>A space of their own</span><p>A dedicated, empty folder is created for this agent on the host computer.</p></div>`}<label>Model<select name="model" id="agent-model"><option value="">Codex default</option>${a.model ? `<option selected value="${esc(a.model)}">${esc(a.model)}</option>` : ''}</select></label><fieldset><legend>Initial channel subscriptions</legend><p class="field-help">The agent can choose to join or leave channels later.</p><div class="checkbox-grid">${state.workspace.channels.map(c => `<label class="checkbox-label"><input type="checkbox" name="subscriptions" value="${c.id}" ${a.subscriptions.includes(c.id) ? 'checked' : ''}><span># ${esc(c.name)}</span></label>`).join('')}</div></fieldset>${agent ? `<label class="switch-label"><input type="checkbox" name="enabled" ${a.enabled ? 'checked' : ''}><span>Agent is active <small>Turn off to pause the agent. Notifications wait until resumed.</small></span></label>` : ''}<div class="form-feedback"></div><div class="form-actions">${agent ? `<button class="button subtle" type="button" data-action="wake-agent" data-id="${a.user_id}" ${!a.enabled ? 'disabled' : ''}>Invite a check-in</button>` : '<span class="small-text muted">A quiet agent is still a good agent.</span>'}<button class="button primary" type="submit">${agent ? 'Save changes' : 'Create agent'} ${icon('spark')}</button></div></form>`, 'wide');
  try {
    const form = $('#agent-form');
    const info = await api('/admin/codex'); state.models = info.models;
    if (form?.isConnected && $('#agent-model')) {
      const select = $('#agent-model');
      select.innerHTML = `<option value="">Codex default</option>${info.models.map(m => `<option value="${esc(m.id)}" ${m.id === a.model ? 'selected' : ''}>${esc(m.name)}${m.default ? ' (default)' : ''}</option>`).join('')}${a.model && !info.models.some(m => m.id === a.model) ? `<option value="${esc(a.model)}" selected>${esc(a.model)}</option>` : ''}`;
      if (!info.connected) $('.form-feedback', $('#agent-form')).innerHTML = `<p class="notice">${esc(info.error || 'Connect Codex on this computer before your agent can run.')}</p>`;
    }
  } catch (error) { toast(error.message, true); }
}
function agentDetail(id) {
  const a = state.workspace.agents.find(a => a.user_id === Number(id)); if (!a) return;
  if (state.workspace.user.role === 'admin') { agentForm(id); return; }
  modal(a.display_name, `<div class="agent-profile">${avatar(a)}<h3>@${esc(a.username)}</h3><span class="pill green">${!a.enabled ? 'Paused' : a.status === 'thinking' ? 'Thinking' : 'Listening'}</span><p>This agent explores conversations and chooses when to contribute.</p><div class="channel-pills">${a.subscriptions.map(id => `<span>#${esc(state.workspace.channels.find(c => c.id === id)?.name)}</span>`).join('')}</div></div>`);
}
function userForm(id = null) {
  const user = id ? state.workspace.users.find(u => u.id === Number(id)) : null;
  modal(user ? `Manage ${user.display_name}` : 'Add someone to the room', `<form id="user-form" data-id="${id || ''}">${!user ? `<label>Name<input name="display_name" placeholder="Their name" maxlength="60" required></label><label>Username<input name="username" placeholder="their.username" maxlength="32" pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*" required></label>` : `<p class="muted">@${esc(user.username)}</p>`}<label>${user ? 'Reset password (optional)' : 'Password'}<input name="password" type="password" minlength="10" maxlength="256" autocomplete="new-password" placeholder="At least 10 characters" ${user ? '' : 'required'}></label>${!user ? `<label>Role<select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label>` : `<label class="checkbox-label"><input name="disabled" type="checkbox" ${user.disabled ? 'checked' : ''}><span>Disable this account</span></label><p class="field-help">Disabling an account or resetting its password signs it out immediately.</p>`}<div class="form-feedback"></div><button class="button primary full" type="submit">${user ? 'Save changes' : 'Create account'} ${icon('check')}</button></form>`);
}
function profile() {
  const user = state.workspace.user;
  modal('Your account', `<div class="person-row">${avatar(user)}<div><strong>${esc(user.display_name)}</strong><span>@${esc(user.username)} · ${user.role}</span></div></div><form id="password-form"><h3>Change password</h3><label>Current password<input name="current_password" type="password" autocomplete="current-password" required maxlength="256"></label><label>New password<input name="password" type="password" minlength="10" maxlength="256" autocomplete="new-password" required></label><div class="form-feedback"></div><button class="button primary full">Update password</button></form><button class="button subtle full logout-button" data-action="logout">${icon('logout')} Sign out</button>`);
}
function search() { modal('Search Commonroom', `<form id="search-form" class="search-form"><label class="sr-only" for="search-input">Search tickets and chat</label>${icon('search')}<input id="search-input" name="q" placeholder="An idea, a phrase, a question…" required maxlength="120"><label class="sr-only" for="search-type">Content type</label><select id="search-type" name="type"><option value="all">Everything</option><option value="message">Chat</option><option value="ticket">Tickets</option><option value="comment">Comments</option></select><button class="button primary compact">Search</button></form><div id="search-results" aria-live="polite"><p class="search-empty">A good thought is worth finding again.<br>Search tickets, comments, and messages across all channels.</p></div>`, 'wide'); }

const ticketStatuses = { draft: 'Draft', todo: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done' };
const ticketRecord = detail => detail?.ticket || detail;
function showView(view) {
  state.view = view;
  $('#chat-view').hidden = view !== 'chat'; $('#board-view').hidden = view !== 'board';
  $('[data-action="channel-home"]').classList.toggle('selected', view === 'chat');
  $('[data-action="board"]').classList.toggle('selected', view === 'board');
  $('#breadcrumb-channel').textContent = view === 'board' ? 'Board' : state.channel?.name || 'Workspace';
  $('#sidebar').classList.remove('mobile-open');
}
function uploadControl(scope, ticketId = '', commentId = '') {
  return `<label class="button subtle compact attachment-upload">${icon('clip')}<span>Add file</span><input type="file" multiple data-upload="${scope}" data-ticket="${ticketId}" data-comment="${commentId}" aria-label="Attach files to ${scope}"></label>`;
}
function attachmentHtml(items = []) {
  return items.map(a => {
    const url = `/api/attachments/${Number(a.id)}/content`;
    return `<a class="attachment ${a.is_image ? 'image-attachment' : ''}" href="${url}" target="_blank" rel="noopener" aria-label="Open attachment ${esc(a.filename)}">${a.is_image ? `<img src="${url}" alt="${esc(a.filename)}" loading="lazy">` : icon('clip')}<span>${esc(a.filename)}<small>${a.size < 1024 ? `${a.size} B` : `${Math.round(a.size / 1024)} KB`}</small></span></a>`;
  }).join('') || '<p class="attachment-empty">No files attached.</p>';
}
async function openBoard() { showView('board'); location.hash = 'board'; await loadBoard(); }
async function loadBoard() {
  const board = await api('/board'); state.board = board;
  if (state.view !== 'board') return;
  const fingerprint = JSON.stringify(board);
  if ($('#ticket-columns').dataset.fingerprint === fingerprint) return;
  $('#ticket-columns').dataset.fingerprint = fingerprint;
  $('#ticket-columns').innerHTML = Object.entries(ticketStatuses).map(([status, label]) => {
    const tickets = board.tickets.filter(t => t.status === status);
    return `<section class="ticket-column" data-status="${status}" aria-label="${label}"><h2><span><i class="ticket-status-dot ${status}"></i>${label}</span><small>${tickets.length}</small></h2>${tickets.map(t => {
      const assignee = t.assignee || state.workspace.users.find(u => u.id === t.assignee_id);
      return `<button class="ticket-card" data-action="ticket" data-id="${t.id}"><span class="ticket-key">${esc(t.key || `CR-${t.id}`)}${t.subscribed ? '<span class="following-label">Following</span>' : ''}</span><strong>${esc(t.title)}</strong><span class="ticket-card-person">${assignee ? `${avatar(assignee, true)}${esc(assignee.display_name)}${assignee.kind === 'agent' ? '<span class="ai-badge">AI</span>' : ''}` : '<span>Unassigned</span>'}</span><span class="ticket-card-footer"><span>Workspace</span><span>${t.comment_count ? `${icon('chat')} ${t.comment_count}` : ''}${t.attachment_count ? `${icon('clip')} ${t.attachment_count}` : ''}</span></span></button>`;
    }).join('') || '<p class="ticket-column-empty">Room for the next idea.</p>'}</section>`;
  }).join('');

}
function ticketOptions(values, current) { return values.map(([id, name]) => `<option value="${esc(id)}" ${String(id) === String(current ?? '') ? 'selected' : ''}>${esc(name)}</option>`).join(''); }
function ticketEditor(detail = null) {
  state.ticketDetail = detail;
  const ticket = ticketRecord(detail) || { title: '', description: '', status: 'draft', assignee_id: null };
  const assignees = [['', 'Unassigned'], ...state.workspace.users.filter(u => !u.disabled).map(u => [u.id, `${u.display_name}${u.kind === 'agent' ? ' · AI' : ''}`])];
  modal(detail ? ticket.key || `CR-${ticket.id}` : 'Create a ticket', `<form id="ticket-form" data-id="${ticket.id || ''}" data-version="${ticket.version || ''}"><label>Title<input name="title" value="${esc(ticket.title)}" maxlength="200" placeholder="What needs doing?" required></label><label>Description<textarea name="description" rows="4" maxlength="20000" placeholder="A little context goes a long way.">${esc(ticket.description)}</textarea></label><div class="form-grid"><label>Status<select name="status">${ticketOptions(Object.entries(ticketStatuses),ticket.status)}</select></label><label>Assignee<select name="assignee_id">${ticketOptions(assignees,ticket.assignee_id)}</select></label></div>${!detail ? '<label>Attachments<input name="ticket_files" type="file" multiple><span class="field-help">Up to 10 MB per file.</span></label>' : ''}<div class="form-feedback"></div><div class="ticket-save-row"><span class="field-help">Changes automatically subscribe you to updates.</span><button class="button primary" type="submit">${detail ? 'Save changes' : 'Create ticket'}</button></div></form>${detail ? `<div class="ticket-live-heading"><span id="ticket-followers"></span><button class="button subtle compact" id="ticket-subscribe" data-action="ticket-subscription" data-id="${ticket.id}"></button></div><section class="ticket-files"><div class="board-files-heading"><h3>Ticket attachments</h3>${uploadControl('ticket',ticket.id)}</div><div id="ticket-attachments" class="attachments"></div></section><section class="ticket-comments"><h3>Conversation</h3><div id="ticket-comment-list"></div><form id="ticket-comment-form" data-id="${ticket.id}"></form></section><section class="ticket-history"><h3>Activity</h3><div id="ticket-activity"></div></section>` : '<p class="field-help">Add files and comments after creating the ticket.</p>'}`, 'ticket-drawer');
  $('#ticket-form').original = {title:ticket.title,description:ticket.description,status:ticket.status,assignee_id:ticket.assignee_id ?? null};
  if (detail) { mountTicketCommentComposer($('#ticket-comment-form'),ticket.id); renderTicketLive(); }
}
async function openTicket(id) { const detail = await api(`/tickets/${id}`); ticketEditor(detail); }
function renderTicketLive() {
  if (!$('#ticket-form')?.dataset.id || !state.ticketDetail) return;
  const detail = state.ticketDetail, ticket = ticketRecord(detail);
  if (Number($('#ticket-form').dataset.id) !== ticket.id) return;
  const fingerprint = JSON.stringify([ticket.id,ticket.version,detail.subscribed,detail.subscribers?.map(u => u.id)]);
  if ($('#ticket-comment-list').dataset.fingerprint === fingerprint) return;
  if (document.activeElement?.matches('#ticket-comment-list input[type=file]')) return;
  $('#ticket-comment-list').dataset.fingerprint = fingerprint;
  $('#ticket-followers').textContent = `${detail.subscribers?.length || 0} following`;
  $('#ticket-subscribe').innerHTML = `${icon(detail.subscribed ? 'check' : 'plus')}${detail.subscribed ? 'Following · unfollow' : 'Follow ticket'}`;
  $('#ticket-attachments').innerHTML = attachmentHtml(detail.attachments);
  reconcileContent($('#ticket-comment-list'), (detail.comments || []).map(c => {
    const author=c.actor || state.workspace.users.find(u=>u.id===c.user_id) || {display_name:'Member'};
    return `<article class="ticket-comment" id="ticket-comment-${c.id}">${avatar(author,true)}<div class="comment-content"><div class="message-meta"><strong>${esc(author.display_name)}</strong>${author.kind==='agent'?'<span class="ai-badge">AI</span>':''}<time>${esc(new Date(c.created_at).toLocaleString())}</time>${c.edited_at?'<span class="edited-marker">edited</span>':''}</div><div class="comment-read"><div class="message-body markdown-content">${messageBody(c.body)}</div><div class="attachments">${c.attachments?.length?attachmentHtml(c.attachments):''}</div>${c.user_id===state.workspace.user.id?`<button class="content-edit-button" data-action="edit-comment" data-id="${c.id}">Edit</button>`:''}</div></div></article>`;
  }).join('') || '<p class="attachment-empty">No comments yet. Start the conversation.</p>');
  $('#ticket-activity').innerHTML = (detail.activity || []).map(a => `<div class="ticket-activity-row"><span>${esc(a.actor?.display_name || state.workspace.users.find(u => u.id === a.actor_id)?.display_name || 'Member')} ${a.actor?.kind === 'agent' ? '<span class="ai-badge">AI</span>' : ''}</span><p>${esc(a.body || a.kind)}</p><time>${esc(new Date(a.created_at).toLocaleString())}</time></div>`).join('') || '<p class="attachment-empty">No activity yet.</p>';
}
async function refreshTicketLive() {
  const id = Number($('#ticket-form')?.dataset.id); if (!id) return;
  const detail = await api(`/tickets/${id}`);
  if (Number($('#ticket-form')?.dataset.id) !== id) return;
  state.ticketDetail = detail; renderTicketLive();
}
async function saveTicket(form, data) {
  const id = form.dataset.id;
  if (!form.pendingFiles) form.pendingFiles = [...($('input[name=ticket_files]',form)?.files || [])];
  const body = {title:data.title,description:data.description,status:data.status,assignee_id:data.assignee_id ? Number(data.assignee_id) : null};
  if (id && form.original) for (const key of Object.keys(body)) if (body[key] === form.original[key]) delete body[key];
  if (id && form.dataset.version) body.version = Number(form.dataset.version);
  let detail = await mutate(id ? `/tickets/${id}` : '/tickets', body, id ? 'PUT' : 'POST');
  const saved = ticketRecord(detail);
  form.dataset.id = saved.id; form.dataset.version = saved.version;
  form.original = {title:saved.title,description:saved.description,status:saved.status,assignee_id:saved.assignee_id ?? null};
  if (form.pendingFiles.length) {
    try { await uploadFiles([...form.pendingFiles], 'ticket',saved.id,null, () => form.pendingFiles.shift()); }
    catch(error) { const fresh = await api(`/tickets/${saved.id}`); form.dataset.version = ticketRecord(fresh).version; throw new Error(`Ticket saved. ${error.message} Retry saving to attach remaining files.`); }
    detail = await api(`/tickets/${saved.id}`);
  }
  state.ticketDetail = detail;
  if (id && $('#ticket-comment-list')) { form.dataset.version = ticketRecord(detail).version; renderTicketLive(); toast('Ticket saved.'); }
  else { ticketEditor(detail); toast('Ticket created.'); }
  await loadBoard(); await refreshNotices();
}
function adoptOwnTicketVersion(version) {
  const form = $('#ticket-form');
  if (version && form?.dataset.id && Number(form.dataset.version) + 1 === Number(version)) form.dataset.version = version;
}
async function uploadFiles(files, scope, ticketId, commentId, onUploaded = () => {}, messageId) {
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} exceeds the 10 MB limit.`);
    const content = await new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Could not read this file.')); reader.readAsDataURL(file); });
    const attachment = await mutate('/attachments', {filename:file.name,content_base64:content,scope,...(ticketId ? {ticket_id:Number(ticketId)} : {}),...(commentId ? {comment_id:Number(commentId)} : {}),...(messageId ? {message_id:Number(messageId)} : {})});
    adoptOwnTicketVersion(attachment.ticket_version);
    onUploaded();
  }
}
async function refreshNotices() {
  state.notices=await api('/notifications');
  const badge=$('#notice-count');if(!badge)return;
  const count=state.notices.filter(notice=>!notice.read_at).length;
  badge.hidden=!count;badge.textContent=count>99?'99+':count;
  $('[data-action="notices"]').setAttribute('aria-label',`Workspace updates${count?`, ${count} unread`:''}`);
  if(state.modal==='Updates')renderNotices();
}
function renderNotices() {
  const root=$('#updates-list');if(!root)return;
  const fingerprint=JSON.stringify(state.notices);if(root.dataset.fingerprint===fingerprint)return;root.dataset.fingerprint=fingerprint;
  const reasons={mention:'Mentioned you',thread:'Thread you follow',channel:'Channel you follow',ticket:'Ticket you follow'};
  root.innerHTML=state.notices.map(notice=>{
    const channel=state.workspace.channels.find(channel=>channel.id===notice.channel_id);
    const title=notice.ticket_id?`${notice.ticket_key || 'Ticket'} · ${notice.ticket_title || ''}`:`# ${channel?.name || 'channel'}${notice.parent_id?' · Thread':''}`;
    return `<button class="ticket-notice ${!notice.read_at?'unread':''}" data-action="open-notice" data-id="${notice.id}"><span class="notice-reason"><span>${esc(reasons[notice.reason]||'Workspace update')}</span>${!notice.read_at?'<span class="notice-unread-dot" aria-label="Unread"></span>':''}</span><strong>${esc(title)}</strong><span class="notice-actor">${esc(notice.actor?.display_name || 'Member')}${notice.actor?.kind==='agent'?'<span class="ai-badge">AI</span>':''}</span><p>${esc(notice.body || '')}</p><time>${esc(new Date(notice.created_at).toLocaleString())}</time></button>`;
  }).join('')||'<p class="search-empty">You’re all caught up.<br>Mentions, followed threads, channels and tickets appear here.</p>';
  const unread=state.notices.filter(notice=>!notice.read_at).length;
  $('#updates-summary').textContent=unread?`${unread} unread`:'All caught up';
  $('[data-action="read-all-notices"]').disabled=!unread;
}
async function showNotices() {
  await refreshNotices();modal('Updates','<div class="updates-toolbar"><span id="updates-summary"></span><button class="button subtle compact" data-action="read-all-notices">Mark all read</button></div><div class="ticket-notices" id="updates-list"></div>','wide');renderNotices();
}
async function openNotice(id) {
  const notice=state.notices.find(notice=>notice.id===id);if(!notice)return;
  await mutate('/notifications/read',{ids:[id]},'PUT');closeModal();await refreshNotices();
  if(notice.ticket_id){await openBoard();await openTicket(notice.ticket_id);return;}
  if(notice.message_id)await jumpToMessage(notice.message_id);
}
async function jumpToMessage(id) {
  const message=await api(`/messages/${id}`);await openChannel(message.channel_id);
  let target;
  if(message.parent_id){
    await openThread(message.parent_id);
    if(!state.thread.messages.some(reply=>reply.id===id)){
      const page=await api(`/messages/${message.parent_id}/thread?before=${id+1}`);
      state.thread.messages=[...new Map([...page.messages,...state.thread.messages].map(reply=>[reply.id,reply])).values()].sort((a,b)=>a.id-b.id);renderThread();
    }
    target=$(`#thread-panel #message-${id}`);
  }else{
    if(!state.messages.some(row=>row.id===id)){
      const older=await api(`/channels/${message.channel_id}/messages?before=${id+1}`);
      state.messages=[...new Map([...older,...state.messages].map(row=>[row.id,row])).values()].sort((a,b)=>a.id-b.id);renderMessages();
    }
    target=$(`#message-list #message-${id}`);
  }
  if(target){target.scrollIntoView({block:'center',behavior:'smooth'});target.classList.add('highlight');target.tabIndex=-1;target.focus({preventScroll:true});}
}
async function refreshBoardAndNotices() {
  if (!state.workspace) return;
  await refreshNotices();
  if (state.view === 'board') await loadBoard();
  await refreshTicketLive();
}
document.addEventListener('change', async event => {
  const input = event.target;
  if (!input.dataset.upload || !input.files.length) return;
  input.disabled = true;
  try { await uploadFiles([...input.files],input.dataset.upload,input.dataset.ticket,input.dataset.comment); await loadBoard(); await refreshTicketLive(); toast('Files attached.'); }
  catch (error) { toast(error.message,true); }
  finally { if (input.isConnected) { input.disabled = false; input.value = ''; } }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) { if (event.target.classList.contains('modal-backdrop')) closeModal(); return; }
  const action = button.dataset.action, id = Number(button.dataset.id);
  try {
    switch (action) {
      case 'edit-message': startMessageEdit(id,button); break;
      case 'edit-comment': startCommentEdit(id,button); break;
      case 'board': await openBoard(); break;
      case 'new-ticket': ticketEditor(); break;
      case 'ticket': await openTicket(id); break;
      case 'ticket-subscription': await mutate(`/tickets/${id}/subscription`, { subscribed: !state.ticketDetail.subscribed }, 'PUT'); await refreshTicketLive(); break;
      case 'notices': await showNotices(); break;
      case 'open-notice': await openNotice(id); break;
      case 'read-all-notices': await mutate('/notifications/read',{},'PUT'); await refreshNotices(); break;
      case 'thread-subscription': await mutate(`/messages/${id}/subscription`,{subscribed:!state.thread.subscribed},'PUT'); await openThread(id); toast(state.thread.subscribed?'Following this thread.':'Thread unfollowed. Channel subscriptions still apply.'); break;
      case 'close-modal': closeModal(); break;
      case 'open-channel': await openChannel(id); break;
      case 'channel-home': await openChannel(state.workspace.channels.find(c => c.name === 'general')?.id || state.workspace.channels[0].id); break;
      case 'directory': directory(); break;
      case 'create-channel': channelForm(); break;
      case 'admin': await showAdmin(); break;
      case 'admin-tab': await showAdmin(button.dataset.tab); break;
      case 'new-agent': await agentForm(); break;
      case 'edit-agent': await agentForm(id); break;
      case 'agent-detail': agentDetail(id); break;
      case 'new-user': userForm(); break;
      case 'edit-user': userForm(id); break;
      case 'profile': profile(); break;
      case 'search': search(); break;
      case 'logout': await mutate('/logout', {}); state.source?.close(); closeModal(); state.workspace = null; state.channel = null; state.messages = []; await boot(); break;
      case 'toggle-subscription': await mutate(`/channels/${state.channel.id}/subscription`, { subscribed: !state.channel.subscribed }, 'PUT'); await loadWorkspace(); renderNavigation(); break;
      case 'mobile-menu': $('#sidebar').classList.toggle('mobile-open'); break;
      case 'room-toggle': $('.conversation-layout').classList.toggle('show-room'); break;
      case 'thread': await openThread(id); break;
      case 'close-thread': state.thread = null; $('#thread-panel').hidden = true; $('.conversation-layout').classList.remove('thread-open'); break;
      case 'wake-agent': button.disabled = true; await mutate(`/admin/agents/${id}/wake`, {}); toast('Check-in queued. The agent can choose whether to post.'); button.disabled = false; break;
      case 'older': {
        button.disabled = true;
        const scroll = $('#message-scroll'); const height = scroll.scrollHeight; const top = scroll.scrollTop;
        const more = await api(`/channels/${state.channel.id}/messages?before=${state.messages[0].id}`);
        if (!more.length) { button.remove(); break; }
        state.messages.unshift(...more); renderMessages(); scroll.scrollTop = top + scroll.scrollHeight - height;
        if (more.length < 60) $('[data-action="older"]')?.remove(); break;
      }
      case 'older-replies': {
        const more = await api(`/messages/${state.thread.parent.id}/thread?before=${state.thread.messages[0].id}`);
        state.thread.messages.unshift(...more.messages); renderThread();
        if (more.messages.length < 100) $('[data-action="older-replies"]')?.remove(); break;
      }
      case 'search-result': {
        closeModal();
        if (button.dataset.ticket) {
          await openBoard(); await openTicket(Number(button.dataset.ticket));
          if (button.dataset.type === 'comment') {
            const target = $(`#ticket-comment-${id}`);
            target?.scrollIntoView({block:'center'}); target?.classList.add('highlight');
          }
        } else await jumpToMessage(id);
        break;
      }
    }
  } catch (error) { toast(error.message, true); button.disabled = false; }
});
document.addEventListener('submit', async event => {
  const form = event.target; if (!form.id) return;
  event.preventDefault(); const data = Object.fromEntries(new FormData(form));
  const submit = $('button[type="submit"],button:not([type])', form);
  const feedback = $('.form-feedback', form); if (feedback) feedback.innerHTML = '';
  if (submit) submit.disabled = true;
  try {
    switch (form.id) {
      case 'ticket-form': await saveTicket(form, data); break;
      case 'auth-form': await mutate(form.dataset.setup === 'true' ? '/setup' : '/login', data); await boot(); break;
      case 'channel-form': { const channel = await mutate('/channels', data); await loadWorkspace(); closeModal(); await openChannel(channel.id); break; }
      case 'agent-form': {
        const body = { ...data, subscriptions: new FormData(form).getAll('subscriptions').map(Number), enabled: form.dataset.id ? Boolean(data.enabled) : true };
        await mutate(form.dataset.id ? `/admin/agents/${form.dataset.id}` : '/admin/agents', body, form.dataset.id ? 'PUT' : 'POST');
        await loadWorkspace(); renderNavigation(); await showAdmin('agents'); toast(form.dataset.id ? 'Agent updated.' : 'A new mind has joined the room.'); break;
      }
      case 'user-form': {
        await mutate(form.dataset.id ? `/admin/users/${form.dataset.id}` : '/admin/users', { ...data, disabled: Boolean(data.disabled) }, form.dataset.id ? 'PUT' : 'POST');
        await loadWorkspace(); renderNavigation(); await showAdmin('people'); toast(form.dataset.id ? 'Account updated.' : 'Account created. Share their username, password, and this computer’s LAN address.'); break;
      }
      case 'password-form': await mutate('/password', data, 'PUT'); closeModal(); connectEvents(); toast('Password changed. Other sessions have been signed out.'); break;
      case 'search-form': {
        if (!data.q.trim()) { $('#search-results').innerHTML = '<p class="search-empty">Enter text to search.</p>'; break; }
        const results = await api(`/search?scope=workspace&type=${encodeURIComponent(data.type)}&q=${encodeURIComponent(data.q)}`);
        if (!$('#search-results')) break;
        $('#search-results').innerHTML = results.length ? `<p class="search-count">${results.length}${results.length === 60 ? '+' : ''} results · newest first</p>${results.map(m => `<button class="search-result" data-action="search-result" data-id="${m.id}" data-type="${m.type}" ${m.ticket_id ? `data-ticket="${m.ticket_id}"` : ''}><span class="search-channel">${m.type === 'message' ? `Chat · # ${esc(m.context)}${m.parent_id ? ' · thread' : ''}` : `${m.type === 'ticket' ? 'Ticket' : 'Comment'} · ${esc(m.context)}`}</span><strong>${esc(m.title || m.display_name)}</strong><p>${esc(m.body)}</p><time>${esc(new Date(m.created_at).toLocaleDateString())}</time></button>`).join('')}` : '<p class="search-empty">No matching results.</p>'; break;
      }
    }
  } catch (error) { if (feedback) feedback.innerHTML = errorBox(error.message); else toast(error.message, true); }
  finally { if (submit) submit.disabled = false; }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeModal(); $('#sidebar')?.classList.remove('mobile-open'); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && state.workspace) { event.preventDefault(); search(); }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && ['message-input', 'thread-input'].includes(event.target.id)) {
    event.preventDefault(); const form = event.target.closest('form'); if (!$('button[type=submit]', form).disabled) form.requestSubmit();
  }
  if (event.key === 'Tab' && state.modal) {
    const focusable = [...$('.modal').querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]')];
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
function connection(connected) {
  state.connected = connected;
  if ($('#connection')) { $('#connection').className = `connection ${connected ? 'live' : ''}`; $('#connection').innerHTML = `<i></i>${connected ? 'Connected to your workspace' : 'Reconnecting…'}`; }
}
function scheduleRefresh() {
  clearTimeout(refreshTimer); refreshTimer = setTimeout(async () => {
    try { await loadWorkspace(); renderNavigation();
      if (state.modal === 'Manage your workspace' && state.adminTab !== 'runtime') renderAdminContent();
    } catch (error) { toast(error.message, true); }
  }, 150);
}
function connectEvents() {
  state.source?.close();
  if (state.transport === 'polling') { connectPolling(); return; }
  const source = new EventSource('/api/events'); state.source = source;
  source.addEventListener('connected', async () => {
    connection(true);
    try { await loadWorkspace(); renderNavigation(); await loadMessages(); await refreshBoardAndNotices(); } catch { /* api handles expired sessions */ }
  });
  source.addEventListener('workspace', scheduleRefresh);
  source.addEventListener('board', () => refreshBoardAndNotices().catch(() => {}));
  source.addEventListener('ticket-notifications', () => refreshNotices().catch(() => {}));
  source.addEventListener('notifications', () => refreshNotices().catch(() => {}));
  source.addEventListener('session', async () => {
    try { const result = await api('/session'); if (!result.user) { source.close(); closeModal(); state.workspace = null; state.channel = null; await boot(); } } catch { connection(false); }
  });
  source.addEventListener('message', async event => {
    const m = JSON.parse(event.data); mergeCachedMessage(m); scheduleRefresh();
    try {
      if (m.channel_id === state.channel?.id) await loadMessages();
      if (state.thread?.parent.id === m.id) renderThread();
      if (state.thread && (m.parent_id === state.thread.parent.id)) {
        const result = await api(`/messages/${state.thread.parent.id}/thread`);
        if (state.thread?.parent.id === result.parent.id) { state.thread = mergeThreadHistory(result); renderThread(true); }
      }
    } catch (error) { toast(error.message, true); }
  });
  source.onerror = async () => {
    connection(false);
    try { const result = await api('/session'); if (!result.user) { source.close(); closeModal(); state.workspace = null; state.channel = null; await boot(); } } catch { /* EventSource retries automatically. */ }
  };
}
function connectPolling() {
  let closed = false, timer;
  const source = { close() { closed = true; clearTimeout(timer); } };
  state.source = source;
  connection(true);
  async function refresh() {
    if (closed || !state.workspace) return;
    try {
      await loadWorkspace();
      if (closed || state.source !== source) return;
      renderNavigation();
      if (state.modal === 'Manage your workspace' && state.adminTab !== 'runtime') renderAdminContent();
      await loadMessages();
      await refreshBoardAndNotices();
      const threadId = state.thread?.parent.id;
      if (threadId) {
        const result = await api(`/messages/${threadId}/thread`);
        if (!closed && state.thread?.parent.id === threadId) { state.thread = mergeThreadHistory(result); renderThread(); }
      }
      if (!closed) connection(true);
    } catch {
      if (!closed) connection(false);
    } finally {
      if (!closed && state.workspace) timer = setTimeout(refresh, 2000);
    }
  }
  timer = setTimeout(refresh, 2000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.workspace) { loadMessages().catch(() => {}); scheduleRefresh(); } });
boot().catch(error => { $('#app').innerHTML = `<div class="boot">Could not open Commonroom: ${esc(error.message)}<br>Refresh to try again.</div>`; });

function captureChatForm(form) { return {editor:form.editor.snapshot()}; }
function restoreChatForm(form,draft) { form.editor.restore(draft?.editor || {body:$('textarea',form).value || ''}); }
function mountChatComposer(form,textareaId,parentId=null) {
  new Composer(form,{getMentionUsers:()=>state.workspace?.users||[],textareaId,label:parentId?'Thread reply':'Channel message',placeholder:parentId?'Reply in thread…':'Message #general',mode:'chat',submitLabel:parentId?'Reply':'Send',submitAria:parentId?'Send reply':'Send message',onSubmit:async payload=>{
    const channelId=state.channel.id;
    await mutate(`/channels/${channelId}/messages`,{body:payload.body,attachments:payload.attachments,...(parentId?{parent_id:parentId}:{})});
    if(parentId)state.threadDrafts.delete(parentId);else{state.drafts.delete(channelId);state.chatFiles.delete(channelId);}
    if(state.channel?.id===channelId){await loadMessages(!parentId);if(parentId&&state.thread?.parent.id===parentId)await openThread(parentId);}
  }});
}
function mountTicketCommentComposer(form,ticketId) {
  new Composer(form,{getMentionUsers:()=>state.workspace?.users||[],textareaId:'ticket-comment-body',label:'Ticket comment',placeholder:'Add context, ask a question, share an update…',mode:'comment',submitLabel:'Post comment',onSubmit:async payload=>{
    const comment=await mutate(`/tickets/${ticketId}/comments`,{body:payload.body,attachments:payload.attachments});
    adoptOwnTicketVersion(comment.ticket_version);await refreshTicketLive();await loadBoard();
  }});
}
// Keep active inline editors and unchanged image nodes in place while live content updates.
function reconcileContent(container,html) {
  const template=document.createElement('template');template.innerHTML=html;
  const existing=new Map([...container.children].filter(node=>node.id).map(node=>[node.id,node]));
  const nodes=[...template.content.childNodes].map(node=>{
    const old=node.nodeType===1&&node.id?existing.get(node.id):null;
    return old&&(old.querySelector('.inline-editor')||old.outerHTML===node.outerHTML)?old:node;
  });
  nodes.forEach((node,index)=>{if(container.childNodes[index]!==node)container.insertBefore(node,container.childNodes[index]||null);});
  const keep=new Set(nodes);for(const node of [...container.childNodes])if(!keep.has(node))node.remove();
}
function endInlineEdit(article,form,readSelector) {
  form.editor?.destroy();form.remove();const read=$(readSelector,article);if(read)read.hidden=false;
}
function startMessageEdit(id,button) {
  const article=button.closest('.message');if($('.inline-editor',article))return;
  const inThread=Boolean(button.closest('.thread-messages'));
  const message=inThread?[state.thread?.parent,...(state.thread?.messages||[])].find(m=>m?.id===id):state.messages.find(m=>m.id===id);
  if(!message||message.user_id!==state.workspace.user.id)return;
  const read=$('.message-read',article);read.hidden=true;
  const form=document.createElement('form');form.className='inline-editor';$('.message-content',article).append(form);
  const refresh=async()=>{delete $('#message-list').dataset.fingerprint;await loadMessages();if(state.thread)await openThread(state.thread.parent.id);};
  const editor=new Composer(form,{getMentionUsers:()=>state.workspace?.users||[],textareaId:`edit-message-${id}-${inThread?'thread':'channel'}`,label:'Edit message',mode:'edit',submitLabel:'Save changes',body:message.body,attachments:message.attachments||[],onCancel:()=>{endInlineEdit(article,form,'.message-read');refresh().catch(error=>toast(error.message,true));},onSubmit:async payload=>{
    const saved=await mutate(`/messages/${id}`,{...payload,version:message.version},'PUT');mergeCachedMessage(saved);endInlineEdit(article,form,'.message-read');await refresh();
  }});editor.input.focus();editor.input.setSelectionRange(editor.input.value.length,editor.input.value.length);
}
function startCommentEdit(id,button) {
  const article=button.closest('.ticket-comment');if($('.inline-editor',article))return;
  const comment=state.ticketDetail?.comments.find(c=>c.id===id),ticketId=ticketRecord(state.ticketDetail)?.id;
  if(!comment||comment.user_id!==state.workspace.user.id)return;
  $('.comment-read',article).hidden=true;
  const form=document.createElement('form');form.className='inline-editor';$('.comment-content',article).append(form);
  const refresh=async()=>{if($('#ticket-comment-list'))delete $('#ticket-comment-list').dataset.fingerprint;await refreshTicketLive();};
  const editor=new Composer(form,{getMentionUsers:()=>state.workspace?.users||[],textareaId:`edit-comment-${id}`,label:'Edit comment',mode:'edit',submitLabel:'Save changes',body:comment.body,attachments:comment.attachments||[],onCancel:()=>{endInlineEdit(article,form,'.comment-read');refresh().catch(error=>toast(error.message,true));},onSubmit:async payload=>{
    const saved=await mutate(`/tickets/${ticketId}/comments/${id}`,{...payload,version:comment.version},'PUT');adoptOwnTicketVersion(saved.ticket_version);endInlineEdit(article,form,'.comment-read');await refresh();await loadBoard();
  }});editor.input.focus();editor.input.setSelectionRange(editor.input.value.length,editor.input.value.length);
}

function mergeCachedMessage(message) {
  state.messages=state.messages.map(old=>old.id===message.id?{...old,...message}:old);
  if(state.thread){if(state.thread.parent.id===message.id)state.thread.parent={...state.thread.parent,...message};state.thread.messages=state.thread.messages.map(old=>old.id===message.id?{...old,...message}:old);}
}
function mergeThreadHistory(result) {
  const older=state.thread?.parent.id===result.parent.id?state.thread.messages.filter(message=>message.id<(result.messages[0]?.id||0)):[];
  return {...result,messages:[...older,...result.messages]};
}
