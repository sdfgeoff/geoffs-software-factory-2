import { AppError, now } from './store.js';

// Mentions are plain @usernames, outside code and URLs. Match complete names,
// rather than prefixes, so @ann cannot accidentally address @anna or @ann.dev.
export function mentionedUsers(body, users) {
  const visible = String(body || '').replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, ' ')
    .replace(/`+[^`\n]*`+/g, ' ').replace(/https?:\/\/[^\s<>()]+/gi, ' ');
  const names = new Map(users.map(user => [user.username.toLowerCase(), user.id]));
  const result = new Set();
  for (const match of visible.matchAll(/(?:^|[^a-z0-9_.@-])@([a-z0-9][a-z0-9_.-]*)/gi)) {
    let name = match[1].toLowerCase();
    if (name.length > 32) {
      if (!/^\.+$/.test(name.slice(32))) continue;
      name = name.slice(0, 32);
    }
    while (name.endsWith('.') && !names.has(name)) name = name.slice(0, -1);
    if (names.has(name)) result.add(names.get(name));
  }
  return result;
}

export class NotificationStore {
  constructor(store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS seen_replies (user_id INTEGER NOT NULL REFERENCES users(id), message_id INTEGER NOT NULL REFERENCES messages(id), PRIMARY KEY(user_id,message_id));
      CREATE TABLE IF NOT EXISTS thread_subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id), parent_id INTEGER NOT NULL REFERENCES messages(id),
      subscribed INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, PRIMARY KEY(user_id,parent_id));
      CREATE TABLE IF NOT EXISTS user_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
        event_key TEXT NOT NULL, type TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL,
        actor_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, channel_id INTEGER REFERENCES channels(id),
        message_id INTEGER REFERENCES messages(id), parent_id INTEGER REFERENCES messages(id),
        ticket_id INTEGER REFERENCES tickets(id), event_id INTEGER REFERENCES ticket_activity(id),
        created_at TEXT NOT NULL, read_at TEXT, UNIQUE(user_id,event_key));
      CREATE INDEX IF NOT EXISTS inbox_user ON user_notifications(user_id,id);
      CREATE INDEX IF NOT EXISTS inbox_unread ON user_notifications(user_id,read_at,id);
      INSERT OR IGNORE INTO thread_subscriptions(user_id,parent_id,created_at)
        SELECT user_id,COALESCE(parent_id,id),MIN(created_at) FROM messages GROUP BY user_id,COALESCE(parent_id,id);
      INSERT OR IGNORE INTO user_notifications(id,user_id,event_key,type,kind,reason,actor_id,body,ticket_id,event_id,created_at,read_at)
        SELECT n.id,n.user_id,'ticket:'||n.event_id,'ticket',a.kind,'ticket',a.actor_id,a.body,n.ticket_id,n.event_id,n.created_at,n.read_at
        FROM user_ticket_notifications n JOIN ticket_activity a ON a.id=n.event_id;`);
    const columns = store.all('PRAGMA table_info(notifications)').map(column => column.name);
    if (!columns.includes('reason')) store.db.exec('ALTER TABLE notifications ADD COLUMN reason TEXT');
    if (!columns.includes('inbox_id')) store.db.exec('ALTER TABLE notifications ADD COLUMN inbox_id INTEGER REFERENCES user_notifications(id)');
    store.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS notification_inbox ON notifications(inbox_id) WHERE inbox_id IS NOT NULL');
  }
  actor(userId) { return this.store.tickets.actor(userId); }
  root(id) {
    const value = Number(id);
    if (!Number.isSafeInteger(value) || value < 1) throw new AppError('Invalid message ID.');
    const message = this.store.message(value);
    if (!message) throw new AppError('Thread not found.', 404);
    return message.parent_id ? this.store.message(message.parent_id) : message;
  }
  followParticipant(userId, parentId) {
    this.store.run(`INSERT INTO thread_subscriptions(user_id,parent_id,subscribed,created_at) VALUES(?,?,1,?)
      ON CONFLICT(user_id,parent_id) DO UPDATE SET subscribed=1`, userId, parentId, now());
  }
  threadState(userId, id) {
    this.actor(userId); const parent = this.root(id);
    return { parent_id: parent.id, subscribed: Boolean(this.store.get('SELECT 1 FROM thread_subscriptions WHERE user_id=? AND parent_id=? AND subscribed=1', userId, parent.id)) };
  }
  threadSubscribe(userId, id, subscribed) {
    this.actor(userId); const parent = this.root(id);
    if (typeof subscribed !== 'boolean') throw new AppError('Subscribed must be a boolean.');
    this.store.run(`INSERT INTO thread_subscriptions(user_id,parent_id,subscribed,created_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id,parent_id) DO UPDATE SET subscribed=excluded.subscribed`, userId, parent.id, subscribed ? 1 : 0, now());
    this.store.onChange('notifications', null);
    return { parent_id: parent.id, subscribed };
  }
  threadSubscriptions(userId) {
    this.actor(userId);
    return this.store.all('SELECT parent_id FROM thread_subscriptions WHERE user_id=? AND subscribed=1 ORDER BY parent_id', userId)
      .map(row => ({ ...this.store.message(row.parent_id), subscribed: true }));
  }
  mentions(body, previousBody) {
    const users = this.store.users(); const ids = mentionedUsers(body, users);
    if (previousBody !== undefined) for (const id of mentionedUsers(previousBody, users)) ids.delete(id);
    return ids;
  }
  deliver(event, recipients, depth, delay = 1000) {
    const priorities = { mention: 4, thread: 3, channel: 2, ticket: 2 };
    const unique = new Map();
    for (const [userId, reason] of recipients) {
      if (!unique.has(userId) || priorities[reason] > priorities[unique.get(userId)]) unique.set(userId, reason);
    }
    for (const [userId, reason] of unique) {
      const user = this.store.publicUser(userId);
      if (!user || user.disabled || user.id === event.actor_id) continue;
      const inserted = this.store.run(`INSERT OR IGNORE INTO user_notifications(user_id,event_key,type,kind,reason,actor_id,body,channel_id,message_id,parent_id,ticket_id,event_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, userId, event.event_key, event.type, event.kind, reason, event.actor_id, event.body,
      event.channel_id || null, event.message_id || null, event.parent_id || null, event.ticket_id || null, event.event_id || null, event.created_at || now());
      if (!Number(inserted.changes)) continue;
      const inboxId = Number(inserted.lastInsertRowid);
      const agent = user.kind === 'agent' && this.store.get('SELECT enabled FROM agents WHERE user_id=?', userId);
      if (agent && depth < 4) this.store.run(`INSERT INTO notifications(agent_id,message_id,kind,ticket_id,event_id,depth,due_at,reason,inbox_id)
        VALUES(?,?,?,?,?,?,?,?,?)`, userId, event.message_id || null, event.type === 'ticket' ? 'ticket' : event.kind,
      event.ticket_id || null, event.event_id || null, depth, Date.now() + delay, reason, inboxId);
    }
  }
  message(actorId, id, kind = 'message', depth = 0, previousBody) {
    const message = this.store.message(id);
    const recipients = [];
    for (const row of this.store.all('SELECT user_id FROM subscriptions WHERE channel_id=?', message.channel_id)) recipients.push([row.user_id, 'channel']);
    for (const row of this.store.all('SELECT user_id FROM thread_subscriptions WHERE parent_id=? AND subscribed=1', message.parent_id || message.id)) recipients.push([row.user_id, 'thread']);
    for (const userId of this.mentions(message.body, previousBody)) recipients.push([userId, 'mention']);
    this.deliver({ event_key: `${kind}:${id}:${message.version}`, type: 'message', kind, actor_id: actorId, body: message.body,
      message_id: message.id, channel_id: message.channel_id, parent_id: message.parent_id }, recipients, Math.max(message.depth, Number(depth) || 0), kind === 'message' ? 2500 : 1000);
  }
  ticket(actorId, eventId, mentionBody = '', previousBody) {
    const event = this.store.tickets.event(eventId); const recipients = [];
    for (const row of this.store.all('SELECT user_id FROM ticket_subscriptions WHERE ticket_id=?', event.ticket_id)) recipients.push([row.user_id, 'ticket']);
    for (const userId of this.mentions(mentionBody, previousBody)) recipients.push([userId, 'mention']);
    this.deliver({ event_key: `ticket:${event.id}`, type: 'ticket', kind: event.kind, actor_id: actorId, body: event.body,
      ticket_id: event.ticket_id, event_id: event.id }, recipients, event.depth);
  }
  changed() { this.store.onChange('notifications', null); this.store.onChange('ticket-notifications', null); }
  list(userId, { unread = false } = {}) {
    this.actor(userId);
    return this.store.all(`SELECT * FROM user_notifications WHERE user_id=? ${unread ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT 100`, userId).map(row => {
      const ticket = row.ticket_id ? this.store.tickets.ticket(row.ticket_id) : null;
      return { ...row, actor: this.store.publicUser(row.actor_id), ticket_key: ticket ? `CR-${ticket.id}` : null, ticket_title: ticket?.title || null };
    });
  }
  groupClause(key) {
    if (typeof key !== 'string' || !/^(ticket|thread|channel):[1-9]\d*$/.test(key)) throw new AppError('Invalid notification group.');
    const [kind,id] = key.split(':');
    return {sql: kind === 'ticket' ? 'ticket_id=?' : kind === 'thread' ? 'ticket_id IS NULL AND parent_id=?' : 'ticket_id IS NULL AND parent_id IS NULL AND channel_id=?', id:Number(id)};
  }
  overview(userId, {filter='all',before,after} = {}) {
    this.actor(userId);
    if (!['all','unread','mentions'].includes(filter)) throw new AppError('Invalid notification filter.');
    const totals=this.store.get(`SELECT COUNT(*) unread,COALESCE(MAX(id),0) latest FROM user_notifications WHERE user_id=? AND read_at IS NULL`,userId);
    const latest=this.store.get('SELECT COALESCE(MAX(id),0) id FROM user_notifications WHERE user_id=?',userId).id;
    const where=filter==='unread'?'AND read_at IS NULL':filter==='mentions'?"AND reason='mention'":'';
    const cursor=before === undefined ? Number.MAX_SAFE_INTEGER : Number(before);
    if(!Number.isSafeInteger(cursor)||cursor<1) throw new AppError('Invalid cursor.');
    const key="CASE WHEN ticket_id IS NOT NULL THEN 'ticket:'||ticket_id WHEN parent_id IS NOT NULL THEN 'thread:'||parent_id ELSE 'channel:'||channel_id END";
    const groups=this.store.all(`SELECT ${key} group_key,MAX(id) id,COUNT(*) total,SUM(read_at IS NULL) unread,SUM(reason='mention' AND read_at IS NULL) mentions FROM user_notifications WHERE user_id=? ${where} GROUP BY group_key HAVING MAX(id)<? ORDER BY id DESC LIMIT 50`,userId,cursor).map(g=>({...g,...this.decorate(this.store.get('SELECT * FROM user_notifications WHERE user_id=? AND id=?',userId,g.id))}));
    const threads=this.store.all(`SELECT m.parent_id,COUNT(*) unread FROM messages m LEFT JOIN seen_replies s ON s.user_id=? AND s.message_id=m.id WHERE m.parent_id IS NOT NULL AND m.user_id<>? AND s.message_id IS NULL GROUP BY m.parent_id`,userId,userId);
    const mentions=this.store.all('SELECT channel_id,COUNT(*) unread FROM user_notifications WHERE user_id=? AND read_at IS NULL AND reason=\'mention\' AND channel_id IS NOT NULL GROUP BY channel_id',userId);
    const since=after===undefined?latest:Number(after);
    if(!Number.isSafeInteger(since)||since<0)throw new AppError('Invalid notification cursor.');
    const arrivals=this.store.all(`SELECT MAX(id) id,channel_id,parent_id,ticket_id,COUNT(*) unread,SUM(reason='mention') mentions FROM user_notifications WHERE user_id=? AND id>? AND read_at IS NULL GROUP BY channel_id,parent_id,ticket_id`,userId,since);
    return {unread:totals.unread,latest,arrivals,groups,threads,mentions,next:groups.length===50?groups.at(-1).id:null};
  }
  decorate(row) {
    const ticket=row.ticket_id?this.store.tickets.ticket(row.ticket_id):null;
    return {...row,actor:this.store.publicUser(row.actor_id),ticket_key:ticket?`CR-${ticket.id}`:null,ticket_title:ticket?.title||null};
  }
  groupEvents(userId,key,before) {
    this.actor(userId);const group=this.groupClause(key),cursor=before===undefined?Number.MAX_SAFE_INTEGER:Number(before);
    if(!Number.isSafeInteger(cursor)||cursor<1)throw new AppError('Invalid cursor.');
    return this.store.all(`SELECT * FROM user_notifications WHERE user_id=? AND ${group.sql} AND id<? ORDER BY id DESC LIMIT 50`,userId,group.id,cursor).map(row=>this.decorate(row));
  }
  setRead(userId,{ids,group,read=true,through}={}) {
    this.actor(userId);
    if(typeof read!=='boolean') throw new AppError('Read must be a boolean.');
    if(ids!==undefined&&(!Array.isArray(ids)||ids.length>100||ids.some(id=>!Number.isSafeInteger(id)||id<1)))throw new AppError('Invalid notification IDs.');
    const cursor=through===undefined?Number.MAX_SAFE_INTEGER:Number(through);
    if(!Number.isSafeInteger(cursor)||cursor<1)throw new AppError('Invalid cursor.');
    let sql='UPDATE user_notifications SET read_at=? WHERE user_id=? AND id<=?',args=[read?now():null,userId,cursor];
    if(group){const clause=this.groupClause(group);sql+=' AND '+clause.sql;args.push(clause.id);}
    if(ids){if(!ids.length)return {ok:true};sql+=` AND id IN (${ids.map(()=>'?').join(',')})`;args.push(...ids);}
    this.store.run(sql,...args);this.changed();return {ok:true};
  }
  seeReplies(userId,parentId,ids) {
    this.actor(userId);const root=this.root(parentId);
    if(!Array.isArray(ids)||ids.length>100||ids.some(id=>!Number.isSafeInteger(id)||id<1))throw new AppError('Invalid reply IDs.');
    this.store.transaction(()=>{for(const id of ids){
      if(!this.store.get('SELECT id FROM messages WHERE id=? AND parent_id=?',id,root.id))throw new AppError('Reply not in this thread.');
      this.store.run('INSERT OR IGNORE INTO seen_replies(user_id,message_id) VALUES(?,?)',userId,id);
      this.store.run('UPDATE user_notifications SET read_at=? WHERE user_id=? AND message_id=? AND read_at IS NULL',now(),userId,id);
    }});this.changed();return {ok:true};
  }
  markRead(userId, ids) {
    this.actor(userId);
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 100 || ids.some(id => !Number.isSafeInteger(id) || id < 1))) throw new AppError('Invalid notification IDs.');
    if (ids === undefined) this.store.run('UPDATE user_notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', now(), userId);
    else this.store.transaction(() => { for (const id of ids) this.store.run('UPDATE user_notifications SET read_at=? WHERE user_id=? AND id=? AND read_at IS NULL', now(), userId, id); });
    this.changed(); return { ok: true };
  }
}
