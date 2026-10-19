import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { Store, passwordHash } from '../server/store.js';

const login = { username: 'admin', display_name: 'Admin', password: 'ticket test password' };
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-tickets-'));
  const service = await createApp({ dataDir, agentsEnabled: false });
  const { port } = await service.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, cookie } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const content = Buffer.from(await response.arrayBuffer());
    let data; try { data = JSON.parse(content.toString()); } catch {}
    return { status: response.status, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0], data, content };
  }
  const setup = await request('/api/setup', { method: 'POST', body: login });
  return { ...service, dataDir, request, admin: setup.data, cookie: setup.cookie };
}

test('persistent board supports human/agent assignment, review, comments and optimistic conflicts', async t => {
  const { request, store, admin, cookie } = await fixture(t);
  assert.equal((await request('/api/board')).status, 401);
  const agent = store.createAgent({ username: 'reviewer', display_name: 'Reviewer', instructions: 'Review carefully.', subscriptions: [] });
  const channel = store.channels(admin.id)[0];
  const created = await request('/api/tickets', { method: 'POST', cookie, body: { title: 'Implement shared board', description: 'A lasting ticket', status: 'todo', assignee_id: agent.user_id, created_by: agent.user_id } });
  assert.equal(created.status, 201);
  assert.equal(created.data.key, `CR-${created.data.id}`);
  assert.equal(created.data.created_by, admin.id);
  assert.equal(created.data.assignee.kind, 'agent');
  assert.ok(created.data.subscribers.some(u => u.id === agent.user_id));
  assert.equal(created.data.subscribed, true);
  assert.equal(created.data.channel_id, undefined);
  assert.equal((await request('/api/tickets', { method: 'POST', cookie, body: { title: 'Linked ticket', channel_id: channel.id } })).status, 400);
  const id = created.data.id;
  const board = await request('/api/board', { cookie });
  assert.equal(board.data.tickets[0].id, id);
  assert.deepEqual(board.data.statuses.map(s => s.id), ['draft', 'todo', 'in_progress', 'review', 'done']);
  const review = await request(`/api/tickets/${id}`, { method: 'PUT', cookie, body: { status: 'review', assignee_id: admin.id, version: created.data.version } });
  assert.equal(review.status, 200);
  assert.equal(review.data.status, 'review');
  assert.equal(review.data.assignee.kind, 'human');
  assert.deepEqual(review.data.activity.at(-1).changes.status, { from: 'todo', to: 'review' });
  const conflict = await request(`/api/tickets/${id}`, { method: 'PUT', cookie, body: { title: 'Stale overwrite', version: created.data.version } });
  assert.equal(conflict.status, 409);
  assert.equal((await request(`/api/tickets/${id}`, { cookie })).data.title, 'Implement shared board');
  const comment = await request(`/api/tickets/${id}/comments`, { method: 'POST', cookie, body: { body: '<script>literal comment</script>', user_id: agent.user_id } });
  assert.equal(comment.status, 201); assert.equal(comment.data.actor.id, admin.id);
  assert.equal(comment.data.ticket_version, review.data.version + 1);
  const detail = await request(`/api/tickets/${id}`, { cookie });
  assert.equal(detail.data.channel_id, undefined);
  assert.equal((await request(`/api/tickets/${id}`, { method: 'PUT', cookie, body: { channel_id: null } })).status, 400);
  assert.equal(detail.data.comments[0].body, '<script>literal comment</script>');
  assert.equal(detail.data.activity.length, 3);
  assert.equal((await request(`/api/tickets/${id}`, { method: 'PUT', cookie, body: { status: 'not-a-status' } })).status, 400);
  assert.equal((await request('/api/tickets', { method: 'POST', cookie, body: { title: '   ' } })).status, 400);
});

test('ticket subscriptions, automatic participation, self suppression, pause and four-hop queues', async t => {
  const { store, admin } = await fixture(t);
  const member = store.createHuman({ username: 'member', display_name: 'Member', password: 'member password123' });
  const make = username => store.createAgent({ username, display_name: username, instructions: 'Listen.', subscriptions: [] });
  const active = make('active'); const paused = make('paused'); const elsewhere = make('elsewhere');
  const ticket = store.tickets.create(admin.id, { title: 'Watched ticket', assignee_id: active.user_id });
  store.tickets.subscribe(paused.user_id, ticket.id, true);
  store.run('UPDATE agents SET enabled=0 WHERE user_id=?', paused.user_id);
  store.run('DELETE FROM notifications');
  store.tickets.comment(member.id, ticket.id, { body: 'A human update' });
  assert.ok(store.tickets.detail(member.id, ticket.id).subscribed);
  assert.deepEqual(store.all('SELECT agent_id FROM notifications').map(n => n.agent_id), [active.user_id, paused.user_id]);
  const notice = store.tickets.notifications(admin.id)[0];
  assert.equal(notice.actor.id, member.id); assert.equal(notice.ticket_key, ticket.key); assert.equal(notice.read_at, null);
  store.tickets.markRead(member.id, [notice.id]);
  assert.equal(store.tickets.notifications(admin.id)[0].read_at, null);
  store.tickets.markRead(admin.id, [notice.id]);
  assert.ok(store.tickets.notifications(admin.id)[0].read_at);
  store.run('DELETE FROM notifications');
  store.tickets.comment(active.user_id, ticket.id, { body: 'An agent update' }, 3);
  assert.deepEqual(store.all('SELECT agent_id FROM notifications').map(n => n.agent_id), [paused.user_id]);
  store.run('DELETE FROM notifications');
  store.tickets.subscribe(elsewhere.user_id, ticket.id, true);
  store.tickets.comment(active.user_id, ticket.id, { body: 'At depth four' }, 4);
  assert.equal(store.all('SELECT * FROM notifications').length, 0);
  store.tickets.comment(active.user_id, ticket.id, { body: 'At depth three' }, 3);
  assert.deepEqual(store.all('SELECT agent_id,depth FROM notifications').map(n => [n.agent_id, n.depth]), [[paused.user_id, 3], [elsewhere.user_id, 3]]);
  store.tickets.subscribe(member.id, ticket.id, false);
  assert.equal(store.tickets.detail(member.id, ticket.id).subscribed, false);
  store.tickets.update(member.id, ticket.id, { title: 'Participated again' });
  assert.equal(store.tickets.detail(member.id, ticket.id).subscribed, true);
});

test('ticket and own-comment attachments remain private and direct board uploads are rejected', async t => {
  const { request, store, admin, cookie, dataDir } = await fixture(t);
  const ticket = store.tickets.create(admin.id, { title: 'Files' });
  const comment = store.tickets.comment(admin.id, ticket.id, { body: 'See files.' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const image = await request('/api/attachments', { method: 'POST', cookie, body: { filename: '../../small.png', content_base64: png.toString('base64'), scope: 'ticket', ticket_id: ticket.id, created_by: 999 } });
  assert.equal(image.status, 201); assert.equal(image.data.filename, 'small.png'); assert.equal(image.data.created_by, admin.id);
  assert.equal(image.data.is_image, true); assert.equal(image.data.ticket_version, comment.ticket_version + 1);
  assert.ok(!JSON.stringify(image.data).includes('disk_path')); assert.ok(!JSON.stringify(image.data).includes(dataDir));
  assert.equal((await request(image.data.content_url)).status, 401);
  const bytes = await request(image.data.content_url, { cookie });
  assert.equal(bytes.headers.get('content-type'), 'image/png'); assert.match(bytes.headers.get('content-disposition'), /^inline;/); assert.deepEqual(bytes.content, png);
  for (const filename of ['unsafe.svg', 'unsafe.html']) {
    const uploaded = await request('/api/attachments', { method: 'POST', cookie, body: { filename, scope: 'comment', comment_id: comment.id, content_base64: Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'), mime_type: 'image/png' } });
    assert.equal(uploaded.status, 201); assert.equal(uploaded.data.mime_type, 'application/octet-stream');
    const unsafe = await request(uploaded.data.content_url, { cookie });
    assert.match(unsafe.headers.get('content-disposition'), /^attachment;/); assert.equal(unsafe.headers.get('x-content-type-options'), 'nosniff'); assert.match(unsafe.headers.get('content-security-policy'), /sandbox/);
  }
  const board = await request('/api/attachments', { method: 'POST', cookie, body: { filename: 'board.txt', scope: 'board', content_base64: Buffer.from('Shared specification').toString('base64') } });
  assert.equal(board.status, 400);
  assert.equal((await request('/api/board', { cookie })).data.attachments, undefined);
  const detail = store.tickets.detail(admin.id, ticket.id);
  assert.equal(detail.attachments.length, 1); assert.equal(detail.comments[0].attachments.length, 2);
  const before = (await readdir(join(dataDir, 'uploads'))).length;
  for (const input of [
    { filename: 'x', scope: 'board', ticket_id: ticket.id, content_base64: 'eA==' },
    { filename: 'x', scope: 'ticket', content_base64: 'eA==' },
    { filename: 'x', scope: 'comment', comment_id: comment.id, ticket_id: 999, content_base64: 'eA==' },
    { filename: 'x', scope: 'board', content_base64: 'not base64!' },
  ]) assert.equal((await request('/api/attachments', { method: 'POST', cookie, body: input })).status, 400);
  assert.equal((await readdir(join(dataDir, 'uploads'))).length, before);
  const other = store.createHuman({ username: 'other', display_name: 'Other', password: 'other password123' });
  assert.throws(() => store.tickets.attach(other.id, { filename: 'x', scope: 'comment', comment_id: comment.id, content_base64: 'eA==' }), /comment author/);
});

test('10 MiB upload works without regex overflow and oversized uploads leave no orphan', async t => {
  const { request, cookie, store, dataDir, admin } = await fixture(t);
  const ticket = store.tickets.create(admin.id, { title: 'Large files' });
  const bytes = Buffer.alloc(10 * 1024 * 1024, 120);
  const upload = await request('/api/attachments', { method: 'POST', cookie, body: { filename: 'limit.bin', scope: 'ticket', ticket_id: ticket.id, content_base64: bytes.toString('base64') } });
  assert.equal(upload.status, 201); assert.equal(upload.data.size, bytes.length);
  assert.deepEqual((await request(upload.data.content_url, { cookie })).content, bytes);
  const oversized = await request('/api/attachments', { method: 'POST', cookie, body: { filename: 'too-large.bin', scope: 'ticket', ticket_id: ticket.id, content_base64: Buffer.alloc(bytes.length + 1).toString('base64') } });
  assert.ok([400, 413].includes(oversized.status));
  assert.equal(store.get('SELECT COUNT(*) n FROM ticket_attachments').n, 1);
  assert.equal((await readdir(join(dataDir, 'uploads'))).length, 1);
});

test('agent attachment import stays in its workspace and blocks symlinks', async t => {
  const { store, agents, admin, dataDir } = await fixture(t);
  const agent = store.createAgent({ username: 'importer', display_name: 'Importer', instructions: 'Work.', subscriptions: [] });
  const root = agents.ensureWorkspace(agent.user_id);
  await writeFile(join(root, 'notes.txt'), 'Agent work');
  await writeFile(join(dataDir, 'private.txt'), 'Host private file');
  await symlink(join(dataDir, 'private.txt'), join(root, 'link.txt'));
  const ticket = store.tickets.create(admin.id, { title: 'Agent work' });
  const imported = store.tickets.importFile(agent.user_id, { path: 'notes.txt', ticket_id: ticket.id }, root);
  assert.equal(imported.created_by, agent.user_id); assert.equal(imported.scope, 'ticket');
  assert.ok(store.tickets.detail(agent.user_id, ticket.id).subscribed);
  assert.equal(Buffer.from(store.tickets.readAttachment(agent.user_id, imported.id).content_base64, 'base64').toString(), 'Agent work');
  assert.throws(() => store.tickets.importFile(agent.user_id, { path: '../private.txt' }, root));
  assert.throws(() => store.tickets.importFile(agent.user_id, { path: 'link.txt' }, root));
});

test('additive migration preserves pre-ticket accounts, messages and queued notifications', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-legacy-ticket-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, 'commonroom.sqlite'); const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,display_name TEXT NOT NULL,kind TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',password_hash TEXT,disabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
    CREATE TABLE channels(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '',created_by INTEGER,created_at TEXT NOT NULL);
    CREATE TABLE agents(user_id INTEGER PRIMARY KEY,instructions TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,thread_id TEXT,status TEXT NOT NULL DEFAULT 'idle',last_error TEXT,last_run_at TEXT,created_at TEXT NOT NULL);
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,channel_id INTEGER NOT NULL,user_id INTEGER NOT NULL,body TEXT NOT NULL,parent_id INTEGER,depth INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
    CREATE TABLE notifications(id INTEGER PRIMARY KEY,agent_id INTEGER NOT NULL,message_id INTEGER,kind TEXT NOT NULL DEFAULT 'message',status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,due_at INTEGER NOT NULL DEFAULT 0);`);
  legacy.prepare('INSERT INTO users VALUES(1,?,?,?,?,?,?,?)').run('legacy', 'Legacy Admin', 'human', 'admin', passwordHash('old password123'), 0, '2026-01-01');
  legacy.exec("INSERT INTO users VALUES(2,'old-agent','Old Agent','agent','member',NULL,0,'2026-01-01'); INSERT INTO channels VALUES(1,'general','Old channel',1,'2026-01-01'); INSERT INTO agents(user_id,instructions,thread_id,created_at) VALUES(2,'Old instructions','old-thread','2026-01-01'); INSERT INTO messages VALUES(1,1,1,'Old conversation',NULL,0,'2026-01-01'); INSERT INTO notifications VALUES(1,2,1,'message','pending',2,1234);");
  legacy.close();
  let store = new Store(path);
  assert.equal(store.publicUser(1).username, 'legacy'); assert.equal(store.message(1).body, 'Old conversation');
  assert.equal(store.get('SELECT attempts FROM notifications WHERE id=1').attempts, 2);
  assert.equal(store.get('SELECT thread_id FROM agents WHERE user_id=2').thread_id, 'old-thread');
  assert.ok(store.all('PRAGMA table_info(notifications)').some(c => c.name === 'ticket_id'));
  const ticket = store.tickets.create(1, { title: 'New feature on old database', assignee_id: 2 });
  store.tickets.comment(2, ticket.id, { body: 'A persistent comment' });
  store.close(); store = new Store(path);
  try {
    assert.equal(store.tickets.detail(1, ticket.id).comments[0].body, 'A persistent comment');
    assert.equal(store.message(1).body, 'Old conversation');
    assert.equal(store.tickets.notifications(1)[0].actor.id, 2);
  } finally { store.close(); }
});
