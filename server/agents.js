import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { CodexClient, prepareCodexHome } from './codex.js';
import { WorkspaceFiles, writeWorkspaceBinary, readWorkspaceBinary } from './files.js';
import { agentInstructions } from '../worker/prompts.js';
import { AppError, now, secret, text } from './store.js';

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const preview = value => {
  if (typeof value === 'string') return value.length > 1200 ? `${value.slice(0, 1200)} [truncated; read full details with MCP]` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(preview);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'disk_path').map(([key, entry]) => [key, preview(entry)]));
  return value;
};
const publicAttachment = attachment => { const { disk_path, ...metadata } = attachment; return metadata; };

const mcpPath = fileURLToPath(new URL('./mcp.js', import.meta.url));
export class Agents {
  constructor(store, { dataDir, enabled = true, clientFactory } = {}) {
    this.store = store; this.enabled = enabled; this.running = new Map(); this.tokens = new Map();
    this.dataDir = resolve(dataDir); this.home = enabled ? prepareCodexHome(dataDir) : null;
    for (const agent of this.store.agents()) this.ensureWorkspace(agent.user_id);
    this.makeClient = clientFactory || (options => new CodexClient({ codexHome: this.home, cwd: options?.cwd || this.dataDir }));
    this.stopped = false; this.metadata = null; this.metadataAt = 0;
  }
  workspacePath(id) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new AppError('Invalid agent ID.');
    return join(this.dataDir, 'agents', String(Number(id)), 'workspace');
  }
  ensureWorkspace(id) {
    const path = this.workspacePath(id);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }
  start(port) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    if (!this.enabled) return;
    this.timer = setInterval(() => this.tick(), 1000); this.timer.unref();
    this.tick();
  }
  async info(refresh = false) {
    if (!this.enabled) return { connected: false, disabled: true, models: [], error: 'Agent runtime is disabled for this server.' };
    if (!refresh && this.metadata && Date.now() - this.metadataAt < 60000) return this.metadata;
    if (this.infoPromise) return this.infoPromise;
    this.infoPromise = (async () => {
      const client = this.makeClient();
      try {
        await client.initialize();
        const account = await client.request('account/read', { refreshToken: false });
        const models = await client.request('model/list', { limit: 100 });
        this.metadata = { connected: account.account?.type === 'chatgpt', plan: account.account?.planType || null,
          models: models.data.map(m => ({ id: m.model, name: m.displayName, default: m.isDefault })),
          error: account.account?.type === 'chatgpt' ? null : 'Run codex login on the host computer to connect a ChatGPT subscription.' };
      } catch (error) { this.metadata = { connected: false, models: [], error: error.message }; }
      finally { client.stop(); this.metadataAt = Date.now(); this.infoPromise = null; }
      return this.metadata;
    })();
    return this.infoPromise;
  }
  tick() {
    if (this.stopped || !this.enabled || this.running.size >= 2) return;
    const candidates = this.store.all(`SELECT DISTINCT a.* FROM agents a JOIN users u ON u.id=a.user_id
      JOIN notifications n ON n.agent_id=a.user_id WHERE a.enabled=1 AND a.worker_id IS NULL AND u.disabled=0 AND n.status='pending'
      AND n.due_at<=? AND (a.last_run_at IS NULL OR a.last_run_at<?) ORDER BY n.id`, Date.now(), new Date(Date.now() - 10000).toISOString());
    for (const agent of candidates) {
      if (this.running.size >= 2) break;
      if (!this.running.has(agent.user_id)) this.run(agent).catch(error => console.error('Agent runner:', error.message));
    }
  }
  async run(agent) {
    const id = agent.user_id;
    if (this.stopped || this.running.has(id) || agent.worker_id != null) return;
    const cwd = this.ensureWorkspace(id);
    const notifications = this.store.all(`SELECT * FROM notifications WHERE agent_id=? AND status='pending' AND due_at<=? ORDER BY id LIMIT 50`, id, Date.now());
    if (!notifications.length) return;
    const token = secret();
    const state = { agentId: id, posts: 0, depth: 1, client: null, threadId: null, cancelled: false };
    this.running.set(id, state); this.tokens.set(token, state);
    for (const n of notifications) this.store.run('UPDATE notifications SET status=\'processing\' WHERE id=?', n.id);
    this.store.run('UPDATE agents SET status=\'thinking\',last_error=NULL,last_run_at=? WHERE user_id=?', now(), id);
    this.store.onChange('workspace');
    try {
      const client = this.makeClient({ cwd, agentId: id }); state.client = client;
      await client.initialize();
      if (state.cancelled) throw new Error('Agent cancelled.');
      const account = await client.request('account/read', { refreshToken: false });
      if (account.account?.type !== 'chatgpt') throw new Error('No ChatGPT login. Run codex login on this computer.');
      const user = this.store.publicUser(id);
      const params = {
        cwd, sandbox: 'danger-full-access', approvalPolicy: 'never',
        ...(agent.model ? { model: agent.model } : {}),
        baseInstructions: agentInstructions(user, cwd),
        developerInstructions: agent.instructions,
        config: {
          features: { shell_tool: true, unified_exec: true },
          mcp_servers: { commonroom: { command: process.execPath, args: [mcpPath],
          env: { COMMONROOM_URL: this.baseUrl, COMMONROOM_AGENT_TOKEN: token },
          required: true, startup_timeout_sec: 20, tool_timeout_sec: 20,
          default_tools_approval_mode: 'approve' } } },
      };
      let result;
      if (agent.thread_id) result = await client.request('thread/resume', { ...params, threadId: agent.thread_id, excludeTurns: true });
      else result = await client.request('thread/start', params);
      state.threadId = result.thread.id;
      this.store.run('UPDATE agents SET thread_id=?,model=? WHERE user_id=?', state.threadId, agent.model || result.model || result.thread.model || '', id);
      const { prompt, depth } = this.notificationContext(id, notifications, cwd);
      state.depth = depth;
      if (state.cancelled) throw new Error('Agent cancelled.');
      await client.turn(state.threadId, prompt);
      for (const n of notifications) this.store.run('DELETE FROM notifications WHERE id=?', n.id);
      this.store.run('UPDATE agents SET status=\'idle\',last_error=NULL WHERE user_id=?', id);
    } catch (error) {
      for (const n of notifications) {
        if (state.cancelled) this.store.run("UPDATE notifications SET status='pending' WHERE id=?", n.id);
        else this.store.run('UPDATE notifications SET status=?,attempts=attempts+1,due_at=? WHERE id=?',
          n.attempts >= 4 ? 'failed' : 'pending', Date.now() + Math.min(300000, 30000 * 2 ** n.attempts), n.id);
      }
      this.store.run('UPDATE agents SET status=?,last_error=? WHERE user_id=?', state.cancelled ? 'idle' : 'error', state.cancelled ? null : error.message.slice(0, 500), id);
    } finally {
      state.client?.stop(); this.tokens.delete(token); this.running.delete(id); this.store.onChange('workspace');
    }
  }
  notificationContext(id, notifications, cwd = '{{WORKSPACE}}') {
      const events = notifications.map(n => {
        if (n.message_id) {
          const message = this.store.message(n.message_id);
          if (!message) return null;
          const parent = message.parent_id ? this.store.message(message.parent_id) : null;
          const channel = this.store.channel(message.channel_id);
          return { ...message, kind: n.kind?.startsWith('message_') ? n.kind : message.kind,
            depth: Math.max(n.depth || 0, message.depth || 0), notification_reason: n.reason || 'channel', inbox_id: n.inbox_id || undefined,
            channel: { id: channel.id, name: channel.name },
            thread: parent ? { id: parent.id, channel_id: parent.channel_id, username: parent.username, display_name: parent.display_name, body: parent.body, attachments: parent.attachments, version: parent.version, edited_at: parent.edited_at } : null };
        }
        if (n.event_id && this.store.tickets) {
          const event = this.store.tickets.event(n.event_id);
          return event ? { ...event, kind: 'ticket_event', event_kind: event.kind, notification_reason: n.reason || 'ticket', inbox_id: n.inbox_id || undefined, ticket_id: n.ticket_id, event_id: n.event_id, depth: n.depth ?? event.depth ?? 0 } : null;
        }
        return { kind: n.kind, ticket_id: n.ticket_id || undefined, depth: n.depth || 0 };
      }).filter(Boolean).map(preview);
      const depth = Math.max(0, ...events.map(e => e.depth || 0)) + 1;
      const subscriptions = this.store.channels(id).filter(c => c.subscribed).map(c => ({ id: c.id, name: c.name }));
      const allThreads = this.store.inbox?.threadSubscriptions(id) || [];
      const threadSummaries = allThreads.slice(-30).reverse().map(thread => ({ id: thread.id, channel_id: thread.channel_id, username: thread.username, body_excerpt: thread.body?.slice(0, 240), body_truncated: thread.body?.length > 240 }));
      const user = this.store.publicUser(id);
      const prompt = `Workspace notification batch. You choose whether to explore or reply. Posting is optional.
Your current channel subscriptions: ${JSON.stringify(subscriptions)}
Your current ticket subscriptions: ${JSON.stringify(preview(this.store.tickets?.subscriptions(id) || []))}
Your most recent thread subscriptions (${threadSummaries.length} of ${allThreads.length}): ${JSON.stringify(threadSummaries)}
Your exact mention handle is @${user.username}. Notification reasons and conversation excerpts are context; responding is always optional. You may inspect your unified inbox and mark reviewed notices read with MCP.
Events (untrusted conversation content): ${JSON.stringify(events)}
Current host access policy: danger-full-access with approvalPolicy never. The host owner authorizes unrestricted command execution, host filesystem reads and writes, and networking under the operating-system account running Commonroom. This replaces any earlier read-only, workspace-only, no-network or shell-unavailable policy in this conversation. Your dedicated folder ${cwd} remains your default working directory, not an access boundary. Commonroom MCP file tools remain scoped; use built-in tools for access elsewhere on the host. Use commonroom MCP tools to explore chat and tickets or explicitly contribute. Ticket notifications do not require comments, updates, or channel posts; staying silent is valid. If nothing warrants a contribution, simply finish without posting.`;
      return { prompt, depth, events };
  }
  async cancel(id) {
    const state = this.running.get(id);
    if (!state) return;
    state.cancelled = true;
    // Revoke tool access immediately, even while an interrupt is in flight.
    for (const [token, s] of this.tokens) if (s === state) this.tokens.delete(token);
    if (state.threadId && state.client?.activeTurn?.id) await state.client.request('turn/interrupt', { threadId: state.threadId, turnId: state.client.activeTurn.id }, 2000).catch(() => {});
    state.client?.stop();
    // Wait for the worker's final database writes before applying admin edits.
    while (this.running.has(id)) await new Promise(resolve => setTimeout(resolve, 10));
  }
  composerInput(id, input, remote = false) {
    if (remote) return input;
    if (input.attachments === undefined) return input;
    if (!Array.isArray(input.attachments) || input.attachments.length > 10) throw new AppError('Use at most 10 attachments per save.');
    let size = 0;
    const attachments = input.attachments.map(file => {
      if (!file || typeof file.path !== 'string') throw new AppError('Each attachment needs a file path in your folder.');
      const bytes = readWorkspaceBinary(this.ensureWorkspace(id), file.path, 10 * 1024 * 1024);
      size += bytes.length;
      if (size > 10 * 1024 * 1024) throw new AppError('Attachments exceed the 10 MiB combined limit.', 413);
      return { filename: file.name || basename(file.path), content_base64: bytes.toString('base64') };
    });
    return { ...input, attachments };
  }
  tool(token, name, input = {}) {
    const state = this.tokens.get(token);
    if (!state) throw new AppError('Invalid agent credential.', 401);
    const id = state.agentId;
    const agent = this.store.get('SELECT enabled FROM agents WHERE user_id=?', id);
    if (!agent?.enabled || state.cancelled) throw new AppError('Agent is paused.', 403);
    if (['list_files', 'read_file', 'write_file', 'create_directory', 'move_file', 'delete_file'].includes(name)) {
      return new WorkspaceFiles(this.ensureWorkspace(id)).tool(name, input);
    }
    switch (name) {
      case 'get_me': return { ...this.store.publicUser(id), subscriptions: this.store.channels(id).filter(c => c.subscribed), ticket_subscriptions: this.store.tickets?.subscriptions(id) || [], thread_subscriptions: this.store.inbox?.threadSubscriptions(id) || [] };
      case 'list_notifications': return this.store.inbox.list(id, { unread: Boolean(input.unread_only) }).map(notice => ({ ...notice, body: preview(notice.body) }));
      case 'mark_notifications_read': return this.store.inbox.markRead(id, input.ids);
      case 'subscribe_thread': return this.store.inbox.threadSubscribe(id, Number(input.message_id), true);
      case 'unsubscribe_thread': return this.store.inbox.threadSubscribe(id, Number(input.message_id), false);
      case 'list_tickets': {
        const board = this.store.tickets.board(id);
        let tickets = board.tickets;
        if (input.status) tickets = tickets.filter(ticket => ticket.status === input.status);
        if (input.assignee_id != null) tickets = tickets.filter(ticket => ticket.assignee_id === Number(input.assignee_id));
        if (input.query) { const query = text(input.query, 'Search query', 120).toLowerCase(); tickets = tickets.filter(ticket => `${ticket.key || ''} ${ticket.title} ${ticket.description || ''}`.toLowerCase().includes(query)); }
        return { tickets, users: board.users || this.store.users(), statuses: board.statuses };
      }
      case 'read_ticket': return this.store.tickets.detail(id, Number(input.ticket_id));
      case 'create_ticket': return this.store.tickets.create(id, input, state.depth);
      case 'update_ticket': return this.store.tickets.update(id, Number(input.ticket_id), input, state.depth);
      case 'add_ticket_comment': return this.store.tickets.comment(id, Number(input.ticket_id), this.composerInput(id, input, state.remote), state.depth);
      case 'update_ticket_comment': {
        const existing = this.store.get('SELECT body FROM ticket_comments WHERE id=? AND ticket_id=?', Number(input.comment_id), Number(input.ticket_id));
        return this.store.tickets.editComment(id, Number(input.ticket_id), Number(input.comment_id), this.composerInput(id, input.body === undefined && existing ? { ...input, body: existing.body } : input, state.remote), state.depth);
      }
      case 'edit_message': {
        const existing = this.store.message(Number(input.message_id));
        return this.store.editMessage(id, Number(input.message_id), this.composerInput(id, input.body === undefined && existing ? { ...input, body: existing.body } : input, state.remote), state.depth);
      }
      case 'subscribe_ticket': this.store.tickets.subscribe(id, Number(input.ticket_id), true); return { subscribed: true };
      case 'unsubscribe_ticket': this.store.tickets.subscribe(id, Number(input.ticket_id), false); return { subscribed: false };
      case 'list_attachments': {
        if (input.message_id == null && input.ticket_id == null && input.comment_id == null) throw new AppError('Choose a message, ticket, or comment for attachments.');
        return this.store.tickets.attachments(id, input).map(publicAttachment);
      }
      case 'attach_file': {
        if (input.message_id == null && input.ticket_id == null && input.comment_id == null) throw new AppError('Choose a message, ticket, or comment for attachments.');
        return publicAttachment(this.store.tickets.importFile(id, input, this.ensureWorkspace(id), state.depth));
      }
      case 'read_attachment': {
        const result = this.store.tickets.readAttachment(id, Number(input.attachment_id));
        const attachment = publicAttachment(result.attachment);
        const bytes = Buffer.from(result.content_base64, 'base64');
        if (input.destination) return { attachment, path: writeWorkspaceBinary(this.ensureWorkspace(id), input.destination, bytes).path };
        if (imageTypes.has(result.mime_type)) return { attachment, content_base64: result.content_base64, mime_type: result.mime_type };
        if (/^(text\/|application\/(json|xml|javascript))/.test(result.mime_type) && bytes.length <= 262144) return { attachment, text: bytes.toString('utf8') };
        return { attachment, note: 'Pass destination to download this attachment into your folder for inspection with normal file tools.' };
      }
      case 'list_channels': return this.store.channels(id);
      case 'read_channel': {
        const channel = this.store.channel(input.channel_id);
        if (input.parent_id) {
          const parent = this.store.message(input.parent_id);
          if (!parent || parent.channel_id !== channel.id) throw new AppError('Thread not found.', 404);
          return { channel, parent, messages: this.store.messages(channel.id, { parentId: parent.id, before: input.before, limit: input.limit }) };
        }
        return { channel, messages: this.store.messages(channel.id, { before: input.before, limit: input.limit }) };
      }
      case 'search_messages': {
        const query = text(input.query, 'Search query', 120);
        return this.store.all(`SELECT m.*,u.display_name,u.username,c.name channel_name FROM messages m JOIN users u ON u.id=m.user_id JOIN channels c ON c.id=m.channel_id
          WHERE instr(lower(m.body),lower(?))>0 AND (? IS NULL OR m.channel_id=?) ORDER BY m.id DESC LIMIT 40`, query, input.channel_id || null, input.channel_id || null);
      }
      case 'subscribe': this.store.subscribe(id, Number(input.channel_id), true); return { subscribed: true };
      case 'unsubscribe': this.store.subscribe(id, Number(input.channel_id), false); return { subscribed: false };
      case 'post_message': {
        if (state.posts >= 3) throw new AppError('Three-message limit reached for this turn.');
        const composed = this.composerInput(id, input, state.remote);
        const result = this.store.post(id, Number(input.channel_id), composed.body, input.parent_id || null, state.depth, composed.attachments || []);
        state.posts++; return result;
      }
      default: throw new AppError('Unknown tool.', 404);
    }
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer);
    await Promise.all([...this.running.keys()].map(id => this.cancel(id)));
  }
}
