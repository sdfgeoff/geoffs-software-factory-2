import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { TicketStore } from './tickets.js';
import { NotificationStore } from './inbox.js';
import { Workers } from './workers.js';

export const now = () => new Date().toISOString();
export const secret = () => randomBytes(32).toString('hex');
export const digest = value => createHash('sha256').update(value).digest('hex');
export function passwordHash(value) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
}
const dummyHash = passwordHash('not-a-real-password');
export function verifyPassword(value, encoded = dummyHash) {
  const [salt, hash] = encoded.split(':');
  const candidate = scryptSync(value, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function text(value, name, max = 2000, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new AppError(`${name} must be ${min}–${max} characters.`);
  }
  return value.trim();
}
export function username(value) {
  const result = text(value, 'Username', 32).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(result)) throw new AppError('Use letters, numbers, dots, hyphens or underscores for the username.');
  return result;
}
export function password(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 256) throw new AppError('Password must be 10–256 characters.');
  return value;
}

export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('human','agent')),
        role TEXT NOT NULL DEFAULT 'member', password_hash TEXT, disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL DEFAULT '',
        created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions (
        user_id INTEGER NOT NULL REFERENCES users(id), channel_id INTEGER NOT NULL REFERENCES channels(id),
        last_read_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,channel_id));
      CREATE TABLE IF NOT EXISTS agents (
        user_id INTEGER PRIMARY KEY REFERENCES users(id), instructions TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1, thread_id TEXT, status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT, last_run_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL REFERENCES channels(id),
        user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL,
        parent_id INTEGER REFERENCES messages(id), depth INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id,id);
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agents(user_id),
        message_id INTEGER REFERENCES messages(id), kind TEXT NOT NULL DEFAULT 'message',
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS notifications_pending ON notifications(status,due_at,agent_id);
      UPDATE notifications SET status='pending' WHERE status='processing';
      UPDATE agents SET status='idle' WHERE status='thinking';`);
    this.onChange = () => {};
    this.tickets = new TicketStore(this, { dataDir: dirname(path) });
    this.inbox = new NotificationStore(this);
    this.workers = new Workers(this);
  }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn) {
    const depth=this.transactionDepth||0; const savepoint=`nested_${depth}`;
    const frame={commit:[],rollback:[]}; this.transactionFrames??=[];
    this.db.exec(depth?`SAVEPOINT ${savepoint}`:'BEGIN IMMEDIATE'); this.transactionFrames.push(frame); this.transactionDepth=depth+1;
    let result;
    try { result = fn(); this.db.exec(depth?`RELEASE SAVEPOINT ${savepoint}`:'COMMIT'); }
    catch (error) { this.db.exec(depth?`ROLLBACK TO SAVEPOINT ${savepoint}`:'ROLLBACK'); if(depth)this.db.exec(`RELEASE SAVEPOINT ${savepoint}`); for(const callback of frame.rollback)callback(); throw error; }
    finally { this.transactionDepth=depth; this.transactionFrames.pop(); }
    if(depth){const parent=this.transactionFrames.at(-1);parent.commit.push(...frame.commit);parent.rollback.push(...frame.rollback);}
    else for(const callback of frame.commit)callback();
    return result;
  }
  afterCommit(callback) { const frame=this.transactionFrames?.at(-1); if(frame)frame.commit.push(callback);else callback(); }
  afterRollback(callback) { const frame=this.transactionFrames?.at(-1); if(frame)frame.rollback.push(callback); }
  hasUsers() { return Boolean(this.get('SELECT id FROM users LIMIT 1')); }
  publicUser(id) { return this.get('SELECT id,username,display_name,kind,role,disabled,created_at FROM users WHERE id=?', id); }
  users() { return this.all('SELECT id,username,display_name,kind,role,disabled,created_at FROM users ORDER BY kind DESC,display_name'); }
  createHuman(input, admin = false) {
    const name = username(input.username);
    const display = text(input.display_name, 'Display name', 60);
    const hash = passwordHash(password(input.password));
    if (this.get('SELECT id FROM users WHERE username=?', name)) throw new AppError('That username is already taken.');
    const id = Number(this.run('INSERT INTO users(username,display_name,kind,role,password_hash,created_at) VALUES(?,?,\'human\',?,?,?)', name, display, admin ? 'admin' : 'member', hash, now()).lastInsertRowid);
    for (const c of this.all('SELECT id FROM channels')) this.subscribe(id, c.id, true);
    return this.publicUser(id);
  }
  setup(input) {
    return this.transaction(() => {
      if (this.hasUsers()) throw new AppError('Workspace already configured.', 409);
      const user = this.createHuman(input, true);
      this.createChannel({ name: 'general', description: 'The common room. Ideas, questions, and conversations for everyone.' }, user.id);
      this.createChannel({ name: 'ideas', description: 'A little room for big possibilities.' }, user.id);
      this.createChannel({ name: 'random', description: 'The interesting things in between.' }, user.id);
      return user;
    });
  }
  createSession(userId) {
    const token = secret();
    this.run('DELETE FROM sessions WHERE expires_at<?', Date.now());
    this.run('INSERT INTO sessions VALUES(?,?,?)', digest(token), userId, Date.now() + 7 * 86400000);
    return token;
  }
  session(token) {
    if (!token) return null;
    return this.get(`SELECT u.id,u.username,u.display_name,u.kind,u.role,u.disabled FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0`, digest(token), Date.now());
  }
  createChannel(input, userId) {
    const name = text(input.name, 'Channel name', 40).toLowerCase().replace(/^#/, '');
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new AppError('Channel names use lowercase letters, numbers, hyphens and underscores.');
    if (this.get('SELECT id FROM channels WHERE name=?', name)) throw new AppError('That channel already exists.');
    const id = Number(this.run('INSERT INTO channels(name,description,created_by,created_at) VALUES(?,?,?,?)', name, text(input.description || '', 'Description', 240, 0), userId, now()).lastInsertRowid);
    this.subscribe(userId, id, true);
    this.onChange('workspace');
    return this.get('SELECT * FROM channels WHERE id=?', id);
  }
  channel(id) {
    const channel = this.get('SELECT * FROM channels WHERE id=?', Number(id));
    if (!channel) throw new AppError('Channel not found.', 404);
    return channel;
  }
  channels(userId) {
    return this.all(`SELECT c.*,COALESCE(s.last_read_id,0) last_read_id,
      CASE WHEN s.user_id IS NULL THEN 0 ELSE 1 END subscribed,
      (SELECT COUNT(*) FROM subscriptions WHERE channel_id=c.id) members,
      (SELECT COUNT(*) FROM messages m WHERE m.channel_id=c.id AND m.id>COALESCE(s.last_read_id,0) AND m.user_id!=?) unread
      FROM channels c LEFT JOIN subscriptions s ON s.channel_id=c.id AND s.user_id=? ORDER BY c.name`, userId, userId);
  }
  subscribe(userId, channelId, value) {
    this.channel(channelId);
    if (value) this.run('INSERT OR IGNORE INTO subscriptions(user_id,channel_id) VALUES(?,?)', userId, channelId);
    else this.run('DELETE FROM subscriptions WHERE user_id=? AND channel_id=?', userId, channelId);
    this.onChange('workspace');
  }
  messages(channelId, { before = Number.MAX_SAFE_INTEGER, parentId = null, limit = 60 } = {}) {
    this.channel(channelId);
    const rows = this.all(`SELECT m.*,u.username,u.display_name,u.kind,
      (SELECT COUNT(*) FROM messages r WHERE r.parent_id=m.id) replies
      FROM messages m JOIN users u ON u.id=m.user_id
      WHERE m.channel_id=? AND m.id<? AND m.parent_id IS ? ORDER BY m.id DESC LIMIT ?`,
    Number(channelId), Number(before), parentId, Math.min(100, Math.max(1, Number(limit))));
    return rows.reverse().map(row => ({ ...row, attachments: this.tickets.messageAttachments(row.id) }));
  }
  message(id) {
    const row = this.get('SELECT m.*,u.username,u.display_name,u.kind FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?', Number(id));
    return row ? { ...row, attachments: this.tickets.messageAttachments(row.id) } : undefined;
  }
  post(userId, channelId, body, parentId = null, depth = 0, attachments = []) {
    this.channel(channelId);
    const user = this.publicUser(userId);
    if (!user || user.disabled) throw new AppError('Account unavailable.', 403);
    const prepared = this.tickets.prepareComposition(userId, { body, attachments }, { scope: 'message' });
    body = prepared.body;
    if (parentId !== null) {
      const parent = this.message(parentId);
      if (!parent || parent.channel_id !== Number(channelId) || parent.parent_id) throw new AppError('Reply must belong to a top-level message in this channel.');
    }
    const message = this.tickets.atomicFiles(files => {
      const id = Number(this.run('INSERT INTO messages(channel_id,user_id,body,parent_id,depth,created_at) VALUES(?,?,?,?,?,?)', Number(channelId), userId, body, parentId, depth, now()).lastInsertRowid);
      this.tickets.applyComposition(userId, { scope: 'message', id }, prepared, files);
      this.run('INSERT OR IGNORE INTO subscriptions(user_id,channel_id) VALUES(?,?)', userId, Number(channelId));
      this.run('UPDATE subscriptions SET last_read_id=? WHERE user_id=? AND channel_id=?', id, userId, Number(channelId));
      this.inbox.followParticipant(userId, parentId || id);
      this.inbox.message(userId, id, 'message', depth);
      return this.message(id);
    });
    this.onChange('message', message);
    this.inbox.changed();
    return message;
  }
  editMessage(userId, id, input, depth = 0) {
    this.tickets.actor(userId); const old = this.message(id);
    if (!old) throw new AppError('Message not found.', 404);
    if (old.user_id !== userId) throw new AppError('Only the message author can edit it.', 403);
    this.tickets.checkVersion(input?.version, old.version);
    const prepared = this.tickets.prepareComposition(userId, { ...input, body: input.body === undefined ? old.body : input.body }, { scope: 'message', id: old.id });
    const notificationDepth = Math.max(old.depth, Number(depth) || 0);
    this.tickets.atomicFiles(files => {
      this.run('UPDATE messages SET body=?,version=version+1,edited_at=?,depth=? WHERE id=?', prepared.body, now(), notificationDepth, old.id);
      this.tickets.applyComposition(userId, { scope: 'message', id: old.id }, prepared, files);
      this.inbox.message(userId, old.id, 'message_edited', notificationDepth, old.body);
    });
    const result = this.message(old.id); this.onChange('message', result); this.inbox.changed(); return result;
  }
  agents() {
    return this.all(`SELECT a.*,u.username,u.display_name,u.disabled,
      (SELECT COUNT(*) FROM notifications n WHERE n.agent_id=a.user_id AND n.status IN ('pending','processing')) pending
      FROM agents a JOIN users u ON a.user_id=u.id ORDER BY u.display_name`).map(a => ({
      ...a, subscriptions: this.all('SELECT channel_id FROM subscriptions WHERE user_id=?', a.user_id).map(s => s.channel_id)
    }));
  }
  createAgent(input) {
    const name = username(input.username);
    const display = text(input.display_name, 'Display name', 60);
    const instructions = text(input.instructions, 'Instructions', 12000);
    const model = text(input.model || '', 'Model', 100, 0);
    const channels = this.validateChannels(input.subscriptions);
    const workerId = this.workers.validateAssignment(input.worker_id);
    if (this.get('SELECT id FROM users WHERE username=?', name)) throw new AppError('That username is already taken.');
    const result = this.transaction(() => {
      const id = Number(this.run('INSERT INTO users(username,display_name,kind,created_at) VALUES(?,?,\'agent\',?)', name, display, now()).lastInsertRowid);
      this.run('INSERT INTO agents(user_id,instructions,model,worker_id,created_at) VALUES(?,?,?,?,?)', id, instructions, model, workerId, now());
      for (const channelId of channels) this.subscribe(id, channelId, true);
      this.run('INSERT INTO notifications(agent_id,kind,due_at) VALUES(?,\'welcome\',?)', id, Date.now() + 2000);
      return id;
    });
    this.onChange('workspace');
    return this.agents().find(a => a.user_id === result);
  }
  validateChannels(value = []) {
    if (!Array.isArray(value) || value.some(id => !Number.isSafeInteger(id))) throw new AppError('Invalid channel subscriptions.');
    for (const id of value) this.channel(id);
    return [...new Set(value)];
  }
  updateAgent(id, input) {
    const previous=this.get('SELECT * FROM agents WHERE user_id=?', id);
    if (!previous) throw new AppError('Agent not found.', 404);
    const display = text(input.display_name, 'Display name', 60);
    const instructions = text(input.instructions, 'Instructions', 12000);
    const model = text(input.model || '', 'Model', 100, 0);
    const channels = this.validateChannels(input.subscriptions);
    const workerId=this.workers.validateAssignment(input.worker_id,previous.worker_id);
    this.transaction(() => {
      this.workers.cancelAgent(id);
      this.run('UPDATE users SET display_name=? WHERE id=?', display, id);
      this.run('UPDATE agents SET instructions=?,model=?,worker_id=?,enabled=?,last_error=NULL,status=\'idle\' WHERE user_id=?', instructions, model, workerId, input.enabled ? 1 : 0, id);
      this.run('DELETE FROM subscriptions WHERE user_id=?', id);
      for (const channelId of channels) this.subscribe(id, channelId, true);
      this.run('UPDATE notifications SET status=\'pending\',attempts=0,due_at=? WHERE agent_id=? AND status=\'failed\'', Date.now(), id);
    });
    this.onChange('workspace');
  }
  close() { this.db.close(); }
}
