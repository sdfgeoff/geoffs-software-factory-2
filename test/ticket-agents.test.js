import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { Agents } from '../server/agents.js';
import { readWorkspaceBinary, writeWorkspaceBinary } from '../server/files.js';

async function fixture(t, turn = async () => {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-ticket-agents-'));
  const store = new Store(join(dataDir, 'commonroom.sqlite'));
  const admin = store.setup({ username: 'admin', display_name: 'Admin', password: 'test password 123' });
  const human = store.createHuman({ username: 'human', display_name: 'Human', password: 'test password 456' });
  const worker = store.createAgent({ username: 'worker', display_name: 'Worker', instructions: 'Contribute when helpful.', subscriptions: [] });
  const watcher = store.createAgent({ username: 'watcher', display_name: 'Watcher', instructions: 'Watch quietly.', subscriptions: [] });
  const agents = new Agents(store, { dataDir, enabled: false, clientFactory: () => ({
    async initialize() {}, async request(method) { return method === 'account/read' ? { account: { type: 'chatgpt' } } : { thread: { id: 'ticket-thread' }, model: 'fake-test-model' }; },
    async turn(thread, prompt) { return turn(prompt); }, stop() {},
  }) });
  store.run('DELETE FROM notifications');
  const state = { agentId: worker.user_id, posts: 0, depth: 1, cancelled: false };
  agents.tokens.set('worker-token', state);
  agents.tokens.set('watcher-token', { ...state, agentId: watcher.user_id });
  const tool = (name, input = {}, token = 'worker-token') => agents.tool(token, name, input);
  t.after(async () => { await agents.stop(); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, agents, admin, human, worker, watcher, tool, state };
}

test('agents share human ticket CRUD, assignment, subscriptions and optimistic versions', async t => {
  const { store, tool, human, worker, watcher } = await fixture(t);
  const ticket = tool('create_ticket', { title: 'Build a shared board', description: 'Owned by the team', status: 'todo', assignee_id: human.id });
  assert.equal(ticket.created_by, worker.user_id);
  assert.equal(ticket.subscribed, true);
  assert.equal(ticket.assignee.id, human.id);
  const board = tool('list_tickets', { status: 'todo', query: 'shared' });
  assert.equal(board.tickets[0].id, ticket.id);
  assert.ok(board.users.some(user => user.id === watcher.user_id && user.kind === 'agent'));
  assert.ok(board.statuses.some(status => status.id === 'review'));
  const moved = tool('update_ticket', { ticket_id: ticket.id, assignee_id: watcher.user_id, status: 'in_progress', version: ticket.version });
  assert.equal(moved.assignee.id, watcher.user_id);
  assert.throws(() => tool('update_ticket', { ticket_id: ticket.id, status: 'done', version: ticket.version }), /changed/);
  const comment = tool('add_ticket_comment', { ticket_id: ticket.id, body: 'Ready for a human review.', user_id: human.id });
  assert.equal(comment.user_id, worker.user_id, 'actor cannot be spoofed');
  assert.equal(tool('read_ticket', { ticket_id: ticket.id }).comments[0].body, 'Ready for a human review.');
  tool('unsubscribe_ticket', { ticket_id: ticket.id });
  assert.equal(tool('read_ticket', { ticket_id: ticket.id }).subscribed, false);
  tool('subscribe_ticket', { ticket_id: ticket.id });
  assert.equal(tool('get_me').ticket_subscriptions[0].id, ticket.id);
  assert.equal(store.all('SELECT * FROM messages').length, 0, 'ticket actions never implicitly post channel messages');
});

test('durable ticket notifications hydrate context, preserve depth and allow silence', async t => {
  let prompt;
  const { store, agents, admin, worker, watcher, tool } = await fixture(t, async input => { prompt = input; return { text: 'This private completion must not be posted.' }; });
  const ticket = store.tickets.create(admin.id, { title: 'Observe quietly', description: 'x'.repeat(20000) });
  tool('subscribe_ticket', { ticket_id: ticket.id });
  store.tickets.subscribe(watcher.user_id, ticket.id, true);
  const comment = store.tickets.comment(admin.id, ticket.id, { body: 'Untrusted comment text '.repeat(400) }, 2);
  const queued = store.all("SELECT * FROM notifications WHERE agent_id=? AND kind='ticket'", worker.user_id);
  assert.equal(queued.length, 1);
  store.run('UPDATE notifications SET due_at=0');
  await agents.run(store.get('SELECT * FROM agents WHERE user_id=?', worker.user_id));
  assert.match(prompt, /ticket_event/);
  assert.match(prompt, /Observe quietly/);
  assert.match(prompt, /"depth":2/);
  assert.match(prompt, /truncated/);
  assert.match(prompt, /current ticket subscriptions/i);
  assert.ok(prompt.length < 15000, 'long ticket context must be previewed');
  assert.equal(store.tickets.detail(admin.id, ticket.id).comments.length, 1);
  assert.equal(store.tickets.detail(admin.id, ticket.id).comments[0].id, comment.id);
  assert.equal(store.all('SELECT * FROM messages').length, 0);
  assert.equal(store.all('SELECT * FROM notifications WHERE agent_id=?', worker.user_id).length, 0);
  assert.ok(store.all('SELECT * FROM notifications WHERE agent_id=?', watcher.user_id).length > 0);
});

test('agent ticket actions preserve four-hop stopping and paused credentials fail closed', async t => {
  const { store, tool, admin, worker, watcher, state } = await fixture(t);
  const ticket = store.tickets.create(admin.id, { title: 'Stop the agent loop' });
  store.tickets.subscribe(watcher.user_id, ticket.id, true);
  state.depth = 4;
  tool('add_ticket_comment', { ticket_id: ticket.id, body: 'Final hop.' });
  assert.equal(store.all('SELECT * FROM notifications').length, 0);
  assert.equal(store.tickets.detail(admin.id, ticket.id).activity.at(-1).depth, 4);
  store.run('UPDATE agents SET enabled=0 WHERE user_id=?', worker.user_id);
  assert.throws(() => tool('list_tickets'), /paused/);
  assert.throws(() => tool('create_ticket', { title: 'Must fail' }), /paused/);
});

test('agents share message/ticket/comment attachments and download only into their folder', async t => {
  const { dataDir, store, agents, admin, worker, tool } = await fixture(t);
  const root = agents.ensureWorkspace(worker.user_id);
  await writeFile(join(root, 'document.txt'), 'Ticket evidence');
  const channel = store.all('SELECT id FROM channels')[0];
  const message = tool('post_message', { channel_id: channel.id, body: 'Here is the evidence.' });
  assert.throws(() => tool('attach_file', { path: 'document.txt' }), /Choose a message/);
  assert.throws(() => tool('list_attachments'), /Choose a message/);
  const messageFile = tool('attach_file', { path: 'document.txt', message_id: message.id });
  assert.equal(messageFile.scope, 'message');
  assert.equal(tool('list_attachments', { message_id: message.id }).length, 1);
  assert.equal(messageFile.disk_path, undefined);
  const channelRead = tool('read_channel', { channel_id: channel.id });
  assert.equal(channelRead.messages[0].attachments[0].id, messageFile.id);
  const someoneElsesMessage = store.post(admin.id, channel.id, 'Human message');
  assert.throws(() => tool('attach_file', { path: 'document.txt', message_id: someoneElsesMessage.id }), /author|own/);
  const ticket = tool('create_ticket', { title: 'Attach evidence' });
  const ticketFile = tool('attach_file', { path: 'document.txt', ticket_id: ticket.id });
  const comment = tool('add_ticket_comment', { ticket_id: ticket.id, body: 'Here is evidence.' });
  const commentFile = tool('attach_file', { path: 'document.txt', comment_id: comment.id });
  assert.equal(commentFile.scope, 'comment');
  assert.equal(tool('list_attachments', { ticket_id: ticket.id }).length, 2);
  const downloaded = tool('read_attachment', { attachment_id: ticketFile.id, destination: 'downloaded.txt' });
  assert.equal(downloaded.path, 'downloaded.txt');
  assert.equal(await readFile(join(root, 'downloaded.txt'), 'utf8'), 'Ticket evidence');
  assert.throws(() => tool('read_attachment', { attachment_id: ticketFile.id, destination: 'downloaded.txt' }), /exist/i);
  assert.throws(() => tool('attach_file', { path: '../document.txt', ticket_id: ticket.id }), /inside/);
  assert.throws(() => tool('read_attachment', { attachment_id: ticketFile.id, destination: '../outside.txt' }), /inside/);
  await symlink(dataDir, join(root, 'escape'));
  assert.throws(() => tool('attach_file', { path: 'escape/commonroom.sqlite', ticket_id: ticket.id }), /links/);
  assert.throws(() => tool('read_attachment', { attachment_id: ticketFile.id, destination: 'escape/outside.txt' }), /links/);
  const png = store.tickets.attach(admin.id, { name: 'tiny.png', ticket_id: ticket.id, content_base64: Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64') });
  assert.equal(tool('read_attachment', { attachment_id: png.id }).mime_type, 'image/png');
  const large = Buffer.alloc(300000, 11);
  writeWorkspaceBinary(root, 'binary.dat', large);
  assert.deepEqual(readWorkspaceBinary(root, 'binary.dat'), large);
  assert.equal(tool('attach_file', { path: 'binary.dat', message_id: message.id }).size, large.length);
});

test('real MCP discovery exposes ticket parity, version fields and image inspection', async t => {
  const { createServer } = await import('node:http');
  const { fileURLToPath } = await import('node:url');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { agents, admin, store, worker } = await fixture(t);
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      const result = agents.tool(request.headers.authorization?.slice(7), input.name, input.input);
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(error.status || 400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'ticket-parity-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../server/mcp.js', import.meta.url))],
    env: { COMMONROOM_URL: `http://127.0.0.1:${server.address().port}`, COMMONROOM_AGENT_TOKEN: 'worker-token' } });
  t.after(async () => { await client.close(); await new Promise(resolve => server.close(resolve)); });
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ['list_notifications','mark_notifications_read','subscribe_thread','unsubscribe_thread','list_tickets','read_ticket','create_ticket','update_ticket','add_ticket_comment','edit_message','update_ticket_comment','subscribe_ticket','unsubscribe_ticket','list_attachments','attach_file','read_attachment']) assert.ok(tools.some(tool => tool.name === name), name);
  const update = tools.find(tool => tool.name === 'update_ticket');
  assert.ok(update.inputSchema.properties.version);
  assert.equal(update.inputSchema.properties.channel_id, undefined);
  assert.equal(update.annotations.readOnlyHint, false);
  const created = await client.callTool({ name: 'create_ticket', arguments: { title: 'Through the actual MCP process', status: 'review' } });
  assert.ok(!created.isError);
  assert.equal(JSON.parse(created.content[0].text).status, 'review');
  assert.ok(!tools.some(tool => tool.name === 'list_board_attachments'));
  const noContext = await client.callTool({ name: 'attach_file', arguments: { path: 'missing.png' } });
  assert.equal(noContext.isError, true);
  const channel = store.all('SELECT id FROM channels')[0];
  const chat = store.post(worker.user_id, channel.id, 'Image attached through MCP');
  const root = agents.ensureWorkspace(worker.user_id);
  await writeFile(join(root, 'mcp-image.png'), Buffer.from([137,80,78,71,13,10,26,10]));
  const imported = await client.callTool({ name: 'attach_file', arguments: { path: 'mcp-image.png', message_id: chat.id } });
  assert.ok(!imported.isError);
  const image = JSON.parse(imported.content[0].text);
  assert.equal(store.message(chat.id).attachments[0].id, image.id);
  const readChat = await client.callTool({ name: 'read_channel', arguments: { channel_id: channel.id } });
  assert.equal(JSON.parse(readChat.content[0].text).messages[0].attachments[0].id, image.id);
  /* image source is uploaded from the agent folder, never board-wide */
  const inspected = await client.callTool({ name: 'read_attachment', arguments: { attachment_id: image.id } });
  assert.ok(inspected.content.some(content => content.type === 'image' && content.mimeType === 'image/png'));
  const edited = await client.callTool({ name: 'edit_message', arguments: { message_id: chat.id, body: 'Updated through the actual MCP process', version: store.message(chat.id).version } });
  assert.ok(!edited.isError, JSON.stringify(edited));
  assert.equal(JSON.parse(edited.content[0].text).attachments[0].id, image.id);
  const newComment = await client.callTool({ name: 'add_ticket_comment', arguments: { ticket_id: JSON.parse(created.content[0].text).id, body: 'Original MCP comment' } });
  const comment = JSON.parse(newComment.content[0].text);
  const revisedComment = await client.callTool({ name: 'update_ticket_comment', arguments: { ticket_id: comment.ticket_id, comment_id: comment.id, body: 'Updated MCP comment', version: comment.version } });
  assert.ok(!revisedComment.isError, JSON.stringify(revisedComment));
  assert.equal(JSON.parse(revisedComment.content[0].text).body, 'Updated MCP comment');
  const subscribed = await client.callTool({ name: 'subscribe_thread', arguments: { message_id: chat.id } });
  assert.equal(JSON.parse(subscribed.content[0].text).subscribed, true);
  const noticeMessage = store.post(admin.id, channel.id, 'A direct @worker mention through the MCP inbox test');
  const inbox = await client.callTool({ name: 'list_notifications', arguments: { unread_only: true } });
  const notice = JSON.parse(inbox.content[0].text).find(row => row.message_id === noticeMessage.id);
  assert.equal(notice.reason, 'mention');
  const marked = await client.callTool({ name: 'mark_notifications_read', arguments: { ids: [notice.id] } });
  assert.equal(JSON.parse(marked.content[0].text).ok, true);
  const unsubscribed = await client.callTool({ name: 'unsubscribe_thread', arguments: { message_id: chat.id } });
  assert.equal(JSON.parse(unsubscribed.content[0].text).subscribed, false);
});

test('message attachment notifications retain attachment metadata and four-hop depth without forced replies', async t => {
  let observed, observedDepth;
  const context = await fixture(t, async prompt => {
    observed = prompt;
    observedDepth = context.agents.running.get(context.watcher.user_id).depth;
  });
  const { store, agents, worker, watcher, tool, state } = context;
  const channel = store.all('SELECT id FROM channels')[0];
  store.subscribe(watcher.user_id, channel.id, true);
  const message = store.post(worker.user_id, channel.id, 'A file for the group.');
  store.run('DELETE FROM notifications');
  const root = agents.ensureWorkspace(worker.user_id);
  await writeFile(join(root, 'evidence.txt'), 'Shared evidence');
  state.depth = 3;
  tool('attach_file', { path: 'evidence.txt', message_id: message.id });
  const queue = store.all('SELECT * FROM notifications WHERE agent_id=?', watcher.user_id);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].kind, 'message_attachment');
  assert.equal(queue[0].depth, 3);
  store.run('UPDATE notifications SET due_at=0');
  await agents.run(store.get('SELECT * FROM agents WHERE user_id=?', watcher.user_id));
  assert.match(observed, /message_attachment/);
  assert.match(observed, /evidence.txt/);
  assert.equal(observedDepth, 4);
  assert.equal(store.all('SELECT * FROM messages').length, 1, 'watcher may finish silently');
  state.depth = 4;
  tool('attach_file', { path: 'evidence.txt', message_id: message.id });
  assert.equal(store.all('SELECT * FROM notifications').length, 0, 'attachment events must stop at hop four');
});

test('agents compose and edit their own messages and replies with atomic attachments and versions', async t => {
  const { store, agents, worker, admin, tool } = await fixture(t);
  const channel = store.all('SELECT id FROM channels')[0];
  const root = agents.ensureWorkspace(worker.user_id);
  await writeFile(join(root, 'first.txt'), 'First evidence');
  await writeFile(join(root, 'second.txt'), 'Second evidence');
  const message = tool('post_message', { channel_id: channel.id, body: 'Initial text', attachments: [{ path: 'first.txt' }] });
  assert.equal(message.attachments.length, 1);
  assert.equal(message.version, 1);
  const revised = tool('edit_message', { message_id: message.id, body: 'Revised text', version: message.version, remove_attachment_ids: [message.attachments[0].id], attachments: [{ path: 'second.txt', name: 'revised.txt' }] });
  assert.equal(revised.body, 'Revised text');
  assert.equal(revised.attachments.length, 1);
  assert.equal(revised.attachments[0].filename, 'revised.txt');
  assert.ok(revised.edited_at);
  assert.ok(revised.version > message.version);
  assert.throws(() => tool('edit_message', { message_id: message.id, body: 'Stale overwrite', version: message.version }), error => error.status === 409);
  const reply = tool('post_message', { channel_id: channel.id, parent_id: message.id, attachments: [{ path: 'first.txt' }] });
  assert.equal(reply.parent_id, message.id);
  assert.equal(reply.body, '');
  const editedReply = tool('edit_message', { message_id: reply.id, body: 'A revised reply', version: reply.version });
  assert.equal(editedReply.parent_id, message.id);
  assert.equal(editedReply.attachments.length, 1);
  const humanMessage = store.post(admin.id, channel.id, 'Human text');
  assert.throws(() => tool('edit_message', { message_id: humanMessage.id, body: 'Impersonation', version: humanMessage.version, user_id: admin.id }), error => error.status === 403);
  const beforeCount = store.all('SELECT * FROM messages').length;
  assert.throws(() => tool('post_message', { channel_id: channel.id, body: 'No partial save', attachments: [{ path: 'first.txt' }, { path: '../outside.txt' }] }), /inside/);
  assert.equal(store.all('SELECT * FROM messages').length, beforeCount);
  const before = store.message(message.id);
  assert.throws(() => tool('edit_message', { message_id: message.id, body: 'Do not partially update', version: before.version, remove_attachment_ids: [reply.attachments[0].id] }));
  assert.equal(store.message(message.id).body, before.body);
  assert.equal(store.message(message.id).version, before.version);
  const attached = tool('attach_file', { message_id: message.id, path: 'first.txt' });
  assert.ok(attached.id);
  assert.ok(store.message(message.id).version > before.version, 'direct attachment invalidates stale message edits');
});

test('agents edit only their own ticket comments with atomic removals and canonical versions', async t => {
  const { store, agents, worker, admin, tool } = await fixture(t);
  const root = agents.ensureWorkspace(worker.user_id);
  await writeFile(join(root, 'comment.txt'), 'Comment attachment');
  const ticket = tool('create_ticket', { title: 'Editable comments' });
  const comment = tool('add_ticket_comment', { ticket_id: ticket.id, attachments: [{ path: 'comment.txt' }] });
  assert.equal(comment.body, '');
  assert.equal(comment.attachments.length, 1);
  const revised = tool('update_ticket_comment', { ticket_id: ticket.id, comment_id: comment.id, body: 'Revised comment', version: comment.version, remove_attachment_ids: [comment.attachments[0].id] });
  assert.equal(revised.body, 'Revised comment');
  assert.equal(revised.attachments.length, 0);
  assert.ok(revised.edited_at);
  assert.ok(revised.version > comment.version);
  assert.throws(() => tool('update_ticket_comment', { ticket_id: ticket.id, comment_id: comment.id, body: 'Stale', version: comment.version }), error => error.status === 409);
  const humanComment = store.tickets.comment(admin.id, ticket.id, { body: 'Human comment' });
  assert.throws(() => tool('update_ticket_comment', { ticket_id: ticket.id, comment_id: humanComment.id, body: 'Impersonation', version: humanComment.version }), error => error.status === 403);
  tool('attach_file', { comment_id: comment.id, path: 'comment.txt' });
  const canonical = tool('read_ticket', { ticket_id: ticket.id }).comments.find(row => row.id === comment.id);
  assert.ok(canonical.version > revised.version, 'direct attachment invalidates stale comment edits');
  assert.equal(canonical.attachments.length, 1);
});

test('agents share unified inbox mentions, isolated read state and explicit thread subscriptions', async t => {
  const { store, admin, human, worker, tool } = await fixture(t);
  const channel = store.all('SELECT id FROM channels')[0];
  const root = store.post(admin.id, channel.id, 'A thread for everyone');
  const reply = store.post(human.id, channel.id, 'Directly asking @worker to look here', root.id);
  const notices = tool('list_notifications', { unread_only: true });
  const mention = notices.find(notice => notice.message_id === reply.id);
  assert.equal(mention.reason, 'mention');
  assert.equal(mention.channel_id, channel.id);
  assert.equal(mention.parent_id, root.id);
  const subscribe = tool('subscribe_thread', { message_id: reply.id });
  assert.equal(subscribe.parent_id, root.id);
  assert.ok(tool('get_me').thread_subscriptions.some(thread => thread.id === root.id));
  const next = store.post(admin.id, channel.id, 'An ordinary follow-up', root.id);
  assert.equal(tool('list_notifications').find(notice => notice.message_id === next.id).reason, 'thread');
  const humanMention = store.post(admin.id, channel.id, 'Hello @human');
  const humanNotice = store.inbox.list(human.id).find(notice => notice.message_id === humanMention.id);
  tool('mark_notifications_read', { ids: [mention.id, humanNotice.id] });
  assert.ok(store.inbox.list(worker.user_id).find(notice => notice.id === mention.id).read_at);
  assert.equal(store.inbox.list(human.id).find(notice => notice.id === humanNotice.id).read_at, null);
  assert.ok(!tool('list_notifications', { unread_only: true }).some(notice => notice.id === mention.id));
  tool('unsubscribe_thread', { message_id: root.id });
  const after = store.post(admin.id, channel.id, 'No thread delivery after unsubscribing', root.id);
  assert.ok(!tool('list_notifications').some(notice => notice.message_id === after.id));
  tool('mark_notifications_read');
  assert.equal(tool('list_notifications', { unread_only: true }).length, 0);
});

test('exact agent mentions wake unsubscribed channels with reason and thread context but allow silence', async t => {
  let observed;
  const { store, agents, admin, human, worker, tool } = await fixture(t, async prompt => { observed = prompt; return { text: 'Private thought only.' }; });
  const channel = store.all('SELECT id FROM channels')[0];
  const root = store.post(admin.id, channel.id, 'Important original thread context');
  const reply = store.post(human.id, channel.id, 'Can @worker review this?', root.id);
  const before = store.all('SELECT * FROM messages').length;
  const queue = store.all('SELECT * FROM notifications WHERE agent_id=?', worker.user_id);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].reason, 'mention');
  store.run('UPDATE notifications SET due_at=0');
  await agents.run(store.get('SELECT * FROM agents WHERE user_id=?', worker.user_id));
  assert.match(observed, /Your exact mention handle is @worker/);
  assert.match(observed, /"notification_reason":"mention"/);
  assert.match(observed, /Important original thread context/);
  assert.match(observed, new RegExp(`"message_id":${reply.id}|"id":${reply.id}`));
  assert.match(observed, /responding is always optional/);
  assert.equal(store.all('SELECT * FROM messages').length, before);
  assert.equal(store.all('SELECT * FROM notifications WHERE agent_id=?', worker.user_id).length, 0);
  assert.ok(tool('list_notifications', { unread_only: true }).some(notice => notice.message_id === reply.id), 'consuming an agent wakeup does not silently mark its inbox read');
  store.post(admin.id, channel.id, 'Final-hop @worker mention', null, 4);
  assert.equal(store.all('SELECT * FROM notifications WHERE agent_id=?', worker.user_id).length, 0);
});

test('agent participation automatically follows its thread after leaving the channel', async t => {
  const { store, worker, admin, tool } = await fixture(t);
  const channel = store.all('SELECT id FROM channels')[0];
  const root = tool('post_message', { channel_id: channel.id, body: 'A conversation I started' });
  tool('unsubscribe', { channel_id: channel.id });
  const reply = store.post(admin.id, channel.id, 'Following up with the original author', root.id);
  assert.equal(tool('list_notifications').find(notice => notice.message_id === reply.id).reason, 'thread');
  assert.ok(store.all('SELECT * FROM notifications WHERE agent_id=?', worker.user_id).some(notice => notice.message_id === reply.id));
});

test('paused agents keep durable mention wakeups and review them after resuming', async t => {
  let turns = 0;
  const { store, agents, admin, worker, tool } = await fixture(t, async () => { turns++; });
  const channel = store.all('SELECT id FROM channels')[0];
  store.run('UPDATE agents SET enabled=0 WHERE user_id=?', worker.user_id);
  const message = store.post(admin.id, channel.id, 'For later: @worker please inspect');
  const queue = store.all('SELECT * FROM notifications WHERE agent_id=?', worker.user_id);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, 'pending');
  assert.ok(store.inbox.list(worker.user_id).some(notice => notice.message_id === message.id));
  assert.throws(() => tool('list_notifications'), /paused/);
  store.run('UPDATE agents SET enabled=1 WHERE user_id=?', worker.user_id);
  store.run('UPDATE notifications SET due_at=0');
  await agents.run(store.get('SELECT * FROM agents WHERE user_id=?', worker.user_id));
  assert.equal(turns, 1);
  assert.equal(store.all('SELECT * FROM notifications WHERE agent_id=?', worker.user_id).length, 0);
  assert.equal(store.all('SELECT * FROM messages').length, 1);
});

test('agent wakeup prompts summarize recent thread subscriptions without flooding context', async t => {
  let observed;
  const { store, agents, admin, worker, tool } = await fixture(t, async prompt => { observed = prompt; });
  const channel = store.all('SELECT id FROM channels')[0];
  for (let index = 0; index < 40; index++) {
    const label = index === 0 ? 'OLD_THREAD_NEVER_IN_PROMPT' : `RECENT_THREAD_${index}`;
    store.post(worker.user_id, channel.id, `${label} ${'x'.repeat(11000)}`);
  }
  tool('unsubscribe', { channel_id: channel.id });
  store.post(admin.id, channel.id, '@worker a small new notification');
  store.run('UPDATE notifications SET due_at=0');
  await agents.run(store.get('SELECT * FROM agents WHERE user_id=?', worker.user_id));
  assert.match(observed, /most recent thread subscriptions \(30 of 40\)/);
  assert.match(observed, /RECENT_THREAD_39/);
  assert.doesNotMatch(observed, /OLD_THREAD_NEVER_IN_PROMPT/);
  assert.ok(observed.length < 20000, 'large subscribed histories should not dominate the wakeup prompt');
});
