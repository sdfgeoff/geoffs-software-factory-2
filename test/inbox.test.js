import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { mentionedUsers } from '../server/inbox.js';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-inbox-'));
  const store = new Store(join(dataDir, 'db.sqlite'));
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const admin = store.setup({ username: 'admin', display_name: 'Admin', password: 'inbox test password' });
  const human = username => store.createHuman({ username, display_name: username, password: 'human test password' });
  const agent = username => store.createAgent({ username, display_name: username, instructions: 'Choose whether to speak.', subscriptions: [] });
  return { store, admin, human, agent, channel: store.channels(admin.id)[0] };
}

test('mentions resolve complete case-insensitive handles and punctuation, excluding email, URLs and code', () => {
  const users = ['alice', 'alice.dev', 'agent_one', 'x-y', 'ann', 'anna'].map((username, index) => ({ id: index + 1, username }));
  const resolved = text => [...mentionedUsers(text, users)];
  assert.deepEqual(resolved('@ALICE, @alice. @alice! @alice.dev @agent_one @x-y'), [1, 2, 3, 4]);
  assert.deepEqual(resolved('@anna @ann'), [6, 5]);
  assert.deepEqual(resolved('@alice-other @alice.unknown @agent_one_extra alice@example.com https://example.com/@alice `@alice` ```js\n@anna\n```'), []);
  assert.deepEqual(resolved('~~~\n@ann\n~~~ Hello @anna.'), [6]);
  const longest = [{ id: 1, username: 'alice' }, { id: 2, username: 'alice.' }];
  assert.deepEqual([...mentionedUsers('@alice..', longest)], [2]);
  assert.deepEqual([...mentionedUsers(`@${'a'.repeat(32)}.`, [{ id: 9, username: 'a'.repeat(32) }])], [9]);
});

test('channel, thread and mention reasons deduplicate per event with identical human and agent targeting', async t => {
  const { store, admin, human, agent, channel } = await fixture(t);
  const alice = human('alice'); const bot = agent('bot');
  store.subscribe(bot.user_id, channel.id, true);
  const root = store.post(admin.id, channel.id, 'Thread starts');
  store.inbox.threadSubscribe(alice.id, root.id, true); store.inbox.threadSubscribe(bot.user_id, root.id, true);
  const reply = store.post(admin.id, channel.id, '@ALICE and @bot, please look.', root.id);
  for (const id of [alice.id, bot.user_id]) {
    const notices = store.inbox.list(id).filter(n => n.message_id === reply.id);
    assert.equal(notices.length, 1); assert.equal(notices[0].reason, 'mention');
    assert.equal(notices[0].parent_id, root.id); assert.equal(notices[0].channel_id, channel.id);
  }
  const queue = store.all('SELECT * FROM notifications WHERE agent_id=? AND message_id=?', bot.user_id, reply.id);
  assert.equal(queue.length, 1); assert.equal(queue[0].reason, 'mention'); assert.equal(queue[0].inbox_id, store.inbox.list(bot.user_id)[0].id);
  assert.equal(store.inbox.list(admin.id).length, 0);
});

test('participants automatically follow threads independently of channels; explicit unfollow survives until replying', async t => {
  const { store, admin, human, channel } = await fixture(t);
  const alice = human('alice'); const bob = human('bob');
  const root = store.post(admin.id, channel.id, 'Question');
  const aliceReply = store.post(alice.id, channel.id, 'I am involved.', root.id);
  assert.equal(store.inbox.threadState(admin.id, root.id).subscribed, true);
  assert.equal(store.inbox.threadState(alice.id, aliceReply.id).subscribed, true);
  store.subscribe(admin.id, channel.id, false); store.subscribe(alice.id, channel.id, false);
  const bobReply = store.post(bob.id, channel.id, 'Following up.', root.id);
  for (const id of [admin.id, alice.id]) assert.equal(store.inbox.list(id).find(n => n.message_id === bobReply.id).reason, 'thread');
  store.inbox.threadSubscribe(alice.id, aliceReply.id, false);
  const muted = store.post(bob.id, channel.id, 'Another reply.', root.id);
  assert.ok(!store.inbox.list(alice.id).some(n => n.message_id === muted.id));
  store.editMessage(alice.id, aliceReply.id, { version: 1, body: 'Edited my older reply.' });
  assert.equal(store.inbox.threadState(alice.id, root.id).subscribed, false);
  store.post(alice.id, channel.id, 'Participating again.', root.id);
  assert.equal(store.inbox.threadState(alice.id, root.id).subscribed, true);
  assert.ok(store.inbox.threadSubscriptions(alice.id).some(message => message.id === root.id));
});

test('paused agents retain inbox and wakeups; disabled and self recipients are excluded; hop cap affects inference only', async t => {
  const { store, admin, human, agent, channel } = await fixture(t);
  const alice = human('alice'); const paused = agent('paused'); const disabled = agent('disabled');
  store.run('UPDATE agents SET enabled=0 WHERE user_id=?', paused.user_id);
  store.run('UPDATE users SET disabled=1 WHERE id=?', disabled.user_id); store.run('DELETE FROM notifications');
  const message = store.post(admin.id, channel.id, '@paused @disabled @admin @alice');
  assert.equal(store.inbox.list(paused.user_id)[0].reason, 'mention');
  assert.equal(store.get('SELECT COUNT(*) n FROM notifications WHERE message_id=?', message.id).n, 1);
  assert.equal(store.get('SELECT COUNT(*) n FROM user_notifications WHERE user_id=?', disabled.user_id).n, 0);
  assert.equal(store.inbox.list(admin.id).length, 0);
  const atCap = store.post(admin.id, channel.id, '@paused and @alice at hop four', null, 4);
  assert.ok(store.inbox.list(alice.id).some(n => n.message_id === atCap.id));
  assert.ok(store.inbox.list(paused.user_id).some(n => n.message_id === atCap.id));
  assert.equal(store.get('SELECT COUNT(*) n FROM notifications WHERE message_id=?', atCap.id).n, 0);
});

test('edits notify newly mentioned users and normal subscribers without repeating unchanged mentions', async t => {
  const { store, admin, human, channel } = await fixture(t);
  const alice = human('alice'); const bob = human('bob'); const follower = human('follower');
  store.subscribe(alice.id, channel.id, false); store.subscribe(bob.id, channel.id, false);
  const message = store.post(admin.id, channel.id, '@alice first version');
  store.editMessage(admin.id, message.id, { version: 1, body: '@alice plus @bob' });
  assert.equal(store.inbox.list(alice.id).filter(n => n.message_id === message.id).length, 1);
  assert.equal(store.inbox.list(bob.id)[0].reason, 'mention');
  assert.equal(store.inbox.list(follower.id)[0].reason, 'channel');
  const ticket = store.tickets.create(admin.id, { title: 'Work', description: '@alice first version' });
  store.tickets.update(admin.id, ticket.id, { description: '@alice plus @bob' });
  assert.equal(store.inbox.list(alice.id).filter(n => n.ticket_id === ticket.id).length, 1);
  assert.equal(store.inbox.list(bob.id).filter(n => n.ticket_id === ticket.id)[0].reason, 'mention');
  const comment = store.tickets.comment(admin.id, ticket.id, { body: '@alice comment' });
  store.tickets.editComment(admin.id, ticket.id, comment.id, { version: 1, body: '@alice and @bob edited comment' });
  assert.equal(store.inbox.list(alice.id).filter(n => n.ticket_id === ticket.id).length, 2);
  assert.equal(store.inbox.list(bob.id).filter(n => n.ticket_id === ticket.id).length, 2);
});

test('unified inbox read state is isolated, deduplicated, durable and rolled back with failed saves', async t => {
  const { store, admin, human, channel } = await fixture(t);
  const alice = human('alice'); const bob = human('bob');
  const message = store.post(admin.id, channel.id, '@alice @bob');
  const notice = store.inbox.list(alice.id)[0];
  store.inbox.markRead(bob.id, [notice.id]); assert.equal(store.inbox.list(alice.id)[0].read_at, null);
  store.inbox.markRead(alice.id, [notice.id]); assert.ok(store.inbox.list(alice.id)[0].read_at);
  assert.deepEqual(store.inbox.list(alice.id, { unread: true }), []);
  store.inbox.message(admin.id, message.id, 'message');
  assert.equal(store.inbox.list(alice.id).length, 1); assert.ok(store.inbox.list(alice.id)[0].read_at);
  const count = store.get('SELECT COUNT(*) n FROM user_notifications').n;
  const deliver = store.inbox.deliver.bind(store.inbox);
  store.inbox.deliver = (...args) => { deliver(...args); throw new Error('Roll back inbox too'); };
  try { assert.throws(() => store.post(admin.id, channel.id, 'A failed save @alice'), /Roll back inbox too/); }
  finally { store.inbox.deliver = deliver; }
  assert.equal(store.get('SELECT COUNT(*) n FROM user_notifications').n, count);
  assert.equal(store.get('SELECT COUNT(*) n FROM messages').n, 1);
});

test('legacy ticket inbox migration preserves read state and backfills participants without replaying history', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-inbox-migration-'));
  t.after(() => rm(dataDir, { recursive: true, force: true })); const path = join(dataDir, 'db.sqlite');
  let store = new Store(path);
  const admin = store.setup({ username: 'admin', display_name: 'Admin', password: 'migration password' });
  const alice = store.createHuman({ username: 'alice', display_name: 'Alice', password: 'alice test password' });
  const root = store.post(admin.id, store.channels(admin.id)[0].id, 'Historic thread'); store.post(alice.id, root.channel_id, 'Historic reply', root.id);
  const ticket = store.tickets.create(admin.id, { title: 'Historic ticket' }); const comment = store.tickets.comment(alice.id, ticket.id, 'Old update');
  const event = store.tickets.detail(admin.id, ticket.id).activity.at(-1);
  store.run('INSERT INTO user_ticket_notifications(id,user_id,ticket_id,event_id,read_at,created_at) VALUES(5,?,?,?,?,?)', admin.id, ticket.id, event.id, '2026-01-02', '2026-01-01');
  store.close();
  const old = new DatabaseSync(path); old.exec('DELETE FROM notifications; DROP INDEX notification_inbox; ALTER TABLE notifications DROP COLUMN inbox_id; DROP TABLE user_notifications; DROP TABLE thread_subscriptions;'); old.close();
  store = new Store(path);
  try {
    assert.equal(store.inbox.list(admin.id).length, 1); assert.equal(store.inbox.list(admin.id)[0].id, 5); assert.equal(store.inbox.list(admin.id)[0].read_at, '2026-01-02');
    assert.equal(store.get('SELECT COUNT(*) n FROM notifications').n, 0);
    assert.ok(store.inbox.threadState(admin.id, root.id).subscribed); assert.ok(store.inbox.threadState(alice.id, root.id).subscribed);
    store.inbox.threadSubscribe(alice.id, root.id, false);
  } finally { store.close(); }
  store = new Store(path);
  try {
    assert.equal(store.inbox.list(admin.id).length, 1); assert.equal(store.inbox.list(admin.id)[0].read_at, '2026-01-02');
    assert.equal(store.inbox.threadState(alice.id, root.id).subscribed, false);
    assert.equal(store.get('SELECT COUNT(*) n FROM notifications').n, 0);
  } finally { store.close(); }
});
