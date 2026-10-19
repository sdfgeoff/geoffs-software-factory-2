import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, text, now } from './store.js';
import { readWorkspaceBinary } from './files.js';

export const ticketStatuses = [
  { id: 'draft', label: 'Draft' }, { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' }, { id: 'review', label: 'Review' }, { id: 'done', label: 'Done' },
];
const maxBytes = 10 * 1024 * 1024;
const idValue = (value, name = 'ID') => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError(`Invalid ${name}.`);
  return id;
};
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}
function filename(value) {
  const name = text(value, 'Filename', 240).split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').replace(/[^\p{L}\p{N} ._()\-]/gu, '_').replace(/^\.+/, '').trim();
  return name || 'attachment';
}

export class TicketStore {
  constructor(store, { dataDir }) {
    this.store = store; this.uploadDir = join(resolve(dataDir), 'uploads');
    mkdirSync(this.uploadDir, { recursive: true, mode: 0o700 });
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft', assignee_id INTEGER REFERENCES users(id), channel_id INTEGER REFERENCES channels(id),
        created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS ticket_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id),
        user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ticket_subscriptions (
        user_id INTEGER NOT NULL REFERENCES users(id), ticket_id INTEGER NOT NULL REFERENCES tickets(id),
        created_at TEXT NOT NULL, PRIMARY KEY(user_id,ticket_id));
      CREATE TABLE IF NOT EXISTS ticket_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id),
        actor_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL, body TEXT NOT NULL,
        changes TEXT NOT NULL DEFAULT '{}', depth INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ticket_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, file_key TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL,
        size INTEGER NOT NULL, scope TEXT NOT NULL, ticket_id INTEGER REFERENCES tickets(id), comment_id INTEGER REFERENCES ticket_comments(id),
        created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS user_ticket_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
        ticket_id INTEGER NOT NULL REFERENCES tickets(id), event_id INTEGER NOT NULL REFERENCES ticket_activity(id),
        read_at TEXT, created_at TEXT NOT NULL, UNIQUE(user_id,event_id));
      CREATE INDEX IF NOT EXISTS ticket_activity_ticket ON ticket_activity(ticket_id,id);
      CREATE INDEX IF NOT EXISTS ticket_notices_user ON user_ticket_notifications(user_id,id);`);
    const columns = store.all('PRAGMA table_info(notifications)').map(c => c.name);
    for (const [name, type] of [['ticket_id', 'INTEGER REFERENCES tickets(id)'], ['event_id', 'INTEGER REFERENCES ticket_activity(id)'], ['depth', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!columns.includes(name)) store.db.exec(`ALTER TABLE notifications ADD COLUMN ${name} ${type}`);
    }
    const attachmentColumns = store.all('PRAGMA table_info(ticket_attachments)').map(c => c.name);
    if (!attachmentColumns.includes('message_id')) store.db.exec('ALTER TABLE ticket_attachments ADD COLUMN message_id INTEGER REFERENCES messages(id)');
    store.db.exec('CREATE INDEX IF NOT EXISTS attachments_message ON ticket_attachments(message_id,id)');
    for (const table of ['messages', 'ticket_comments']) {
      const fields = store.all(`PRAGMA table_info(${table})`).map(column => column.name);
      if (!fields.includes('version')) store.db.exec(`ALTER TABLE ${table} ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
      if (!fields.includes('edited_at')) store.db.exec(`ALTER TABLE ${table} ADD COLUMN edited_at TEXT`);
    }
  }
  actor(userId) {
    const user = this.store.publicUser(idValue(userId, 'user'));
    if (!user || user.disabled) throw new AppError('Account unavailable.', 403);
    return user;
  }
  ticket(id) {
    const row = this.store.get('SELECT * FROM tickets WHERE id=?', idValue(id, 'ticket'));
    if (!row) throw new AppError('Ticket not found.', 404);
    return row;
  }
  summary(row, userId) {
    const { channel_id, ...ticket } = row;
    return { ...ticket, key: `CR-${row.id}`, assignee: row.assignee_id ? this.store.publicUser(row.assignee_id) : null,
      creator: this.store.publicUser(row.created_by),
      comment_count: this.store.get('SELECT COUNT(*) count FROM ticket_comments WHERE ticket_id=?', row.id).count,
      attachment_count: this.store.get('SELECT COUNT(*) count FROM ticket_attachments WHERE ticket_id=?', row.id).count,
      subscribed: Boolean(this.store.get('SELECT 1 FROM ticket_subscriptions WHERE user_id=? AND ticket_id=?', userId, row.id)) };
  }
  board(userId) {
    this.actor(userId);
    return { tickets: this.store.all('SELECT * FROM tickets ORDER BY updated_at DESC,id DESC').map(row => this.summary(row, userId)),
      statuses: ticketStatuses, users: this.store.users() };
  }
  detail(userId, id) {
    this.actor(userId); const ticket = this.ticket(id);
    return { ...this.summary(ticket, userId), comments: this.store.all('SELECT * FROM ticket_comments WHERE ticket_id=? ORDER BY id', ticket.id).map(row => this.publicComment(userId, row)),
      attachments: this.attachments(userId, { ticket_id: ticket.id }).filter(a => a.scope === 'ticket'),
      activity: this.store.all('SELECT * FROM ticket_activity WHERE ticket_id=? ORDER BY id', ticket.id).map(row => this.publicEvent(row)),
      subscribers: this.store.all('SELECT user_id FROM ticket_subscriptions WHERE ticket_id=? ORDER BY user_id', ticket.id).map(row => this.store.publicUser(row.user_id)) };
  }
  publicComment(userId, row) {
    return { ...row, actor: this.store.publicUser(row.user_id), attachments: this.attachments(userId, { comment_id: row.id }), ticket_version: this.ticket(row.ticket_id).version };
  }
  publicEvent(row) {
    if (!row) return null;
    const ticket = this.ticket(row.ticket_id);
    return { ...row, changes: JSON.parse(row.changes), actor: this.store.publicUser(row.actor_id), ticket_key: `CR-${ticket.id}`, ticket_title: ticket.title };
  }
  event(id) { return this.publicEvent(this.store.get('SELECT * FROM ticket_activity WHERE id=?', idValue(id, 'event'))); }
  subscriptions(userId) {
    this.actor(userId);
    return this.store.all('SELECT t.* FROM tickets t JOIN ticket_subscriptions s ON s.ticket_id=t.id WHERE s.user_id=? ORDER BY t.id', userId).map(row => this.summary(row, userId));
  }
  addSubscription(userId, ticketId) {
    this.store.run('INSERT OR IGNORE INTO ticket_subscriptions(user_id,ticket_id,created_at) VALUES(?,?,?)', userId, ticketId, now());
  }
  record(userId, ticketId, kind, body, changes = {}, depth = 0) {
    depth = Math.max(0, Number(depth) || 0);
    this.addSubscription(userId, ticketId);
    const createdAt = now();
    const eventId = Number(this.store.run('INSERT INTO ticket_activity(ticket_id,actor_id,kind,body,changes,depth,created_at) VALUES(?,?,?,?,?,?,?)', ticketId, userId, kind, body, JSON.stringify(changes), depth, createdAt).lastInsertRowid);
    const ticket = this.ticket(ticketId);
    let mentionBody = ''; let previousBody;
    if (kind === 'created') mentionBody = `${ticket.title}\n${ticket.description}`;
    if (kind === 'updated') {
      mentionBody = `${ticket.title}\n${ticket.description}`;
      previousBody = `${changes.title?.from ?? ticket.title}\n${changes.description?.from ?? ticket.description}`;
    }
    if (kind === 'commented') mentionBody = body;
    if (kind === 'comment_edited') { mentionBody = changes.body?.to || ''; previousBody = changes.body?.from || ''; }
    this.store.inbox.ticket(userId, eventId, mentionBody, previousBody);
    return eventId;
  }
  changed(ticketId) { this.store.onChange('board', { ticket_id: ticketId }); this.store.inbox.changed(); }
  validate(input, previous = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('Ticket input must be an object.');
    if ('channel_id' in input) throw new AppError('Tickets are standalone and cannot link to a channel.');
    const fields = {};
    if ('title' in input) fields.title = text(input.title, 'Title', 200);
    if ('description' in input) fields.description = text(input.description, 'Description', 20000, 0);
    if ('status' in input) {
      if (!ticketStatuses.some(s => s.id === input.status)) throw new AppError('Invalid ticket status.');
      fields.status = input.status;
    }
    if ('assignee_id' in input) {
      fields.assignee_id = input.assignee_id === null ? null : idValue(input.assignee_id, 'assignee');
      if (fields.assignee_id !== null && !this.actor(fields.assignee_id)) throw new AppError('Assignee not found.');
    }
    return { ...previous, ...fields };
  }
  create(userId, input, depth = 0) {
    this.actor(userId);
    const fields = this.validate(input, { description: '', status: 'draft', assignee_id: null });
    fields.title = text(fields.title, 'Title', 200);
    const id = this.store.transaction(() => {
      const time = now();
      const id = Number(this.store.run('INSERT INTO tickets(title,description,status,assignee_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', fields.title, fields.description, fields.status, fields.assignee_id, userId, time, time).lastInsertRowid);
      if (fields.assignee_id) this.addSubscription(fields.assignee_id, id);
      this.record(userId, id, 'created', 'Created the ticket.', {}, depth);
      return id;
    });
    this.changed(id); return this.detail(userId, id);
  }
  update(userId, id, input, depth = 0) {
    this.actor(userId); const old = this.ticket(id); const fields = this.validate(input, old);
    if (input.version !== undefined && input.version !== old.version) throw new AppError('This ticket changed. Refresh it and try again.', 409);
    const changes = Object.fromEntries(['title', 'description', 'status', 'assignee_id'].filter(field => fields[field] !== old[field]).map(field => [field, { from: old[field], to: fields[field] }]));
    this.store.transaction(() => {
      this.addSubscription(userId, old.id);
      if (!Object.keys(changes).length) return;
      this.store.run('UPDATE tickets SET title=?,description=?,status=?,assignee_id=?,updated_at=?,version=version+1 WHERE id=?', fields.title, fields.description, fields.status, fields.assignee_id, now(), old.id);
      if (fields.assignee_id) this.addSubscription(fields.assignee_id, old.id);
      const body = changes.status ? `Moved ticket from ${old.status} to ${fields.status}.` : 'Updated the ticket.';
      this.record(userId, old.id, 'updated', body, changes, depth);
    });
    this.changed(old.id); return this.detail(userId, old.id);
  }
  comment(userId, id, input, depth = 0) {
    this.actor(userId); const ticket = this.ticket(id);
    const prepared = this.prepareComposition(userId, typeof input === 'string' ? { body: input } : input, { scope: 'comment' });
    const body = prepared.body;
    const commentId = this.atomicFiles(files => {
      const id = Number(this.store.run('INSERT INTO ticket_comments(ticket_id,user_id,body,created_at) VALUES(?,?,?,?)', ticket.id, userId, body, now()).lastInsertRowid);
      this.applyComposition(userId, { scope: 'comment', id, ticket_id: ticket.id }, prepared, files);
      this.store.run('UPDATE tickets SET updated_at=?,version=version+1 WHERE id=?', now(), ticket.id);
      this.record(userId, ticket.id, 'commented', body || 'Added attachments.', { comment_id: id }, depth); return id;
    });
    this.changed(ticket.id); return this.publicComment(userId, this.store.get('SELECT * FROM ticket_comments WHERE id=?', commentId));
  }
  editComment(userId, ticketId, commentId, input, depth = 0) {
    this.actor(userId); const ticket = this.ticket(ticketId);
    const comment = this.store.get('SELECT * FROM ticket_comments WHERE id=? AND ticket_id=?', idValue(commentId, 'comment'), ticket.id);
    if (!comment) throw new AppError('Comment not found.', 404);
    if (comment.user_id !== userId) throw new AppError('Only the comment author can edit it.', 403);
    this.checkVersion(input?.version, comment.version);
    const prepared = this.prepareComposition(userId, { ...input, body: input.body === undefined ? comment.body : input.body }, { scope: 'comment', id: comment.id });
    this.atomicFiles(files => {
      this.store.run('UPDATE ticket_comments SET body=?,version=version+1,edited_at=? WHERE id=?', prepared.body, now(), comment.id);
      this.applyComposition(userId, { scope: 'comment', id: comment.id, ticket_id: ticket.id }, prepared, files);
      this.store.run('UPDATE tickets SET updated_at=?,version=version+1 WHERE id=?', now(), ticket.id);
      this.record(userId, ticket.id, 'comment_edited', 'Edited a comment.', { comment_id: comment.id, body: { from: comment.body, to: prepared.body }, removed_attachment_ids: prepared.removed.map(row => row.id), added_attachment_count: prepared.additions.length }, depth);
    });
    this.changed(ticket.id); return this.publicComment(userId, this.store.get('SELECT * FROM ticket_comments WHERE id=?', comment.id));
  }
  checkVersion(version, current) {
    if (!Number.isSafeInteger(version) || version < 1) throw new AppError('A valid version is required when editing.');
    if (version !== current) throw new AppError('This content changed. Refresh it and try again.', 409);
  }
  decodeUpload(input) {
    if (!input || typeof input.content_base64 !== 'string' || input.content_base64.length > Math.ceil(maxBytes / 3) * 4) throw new AppError('Invalid base64 attachment. Maximum size is 10 MiB.');
    const bytes = Buffer.from(input.content_base64, 'base64');
    if (bytes.length > maxBytes) throw new AppError('Attachment exceeds 10 MiB.', 413);
    if (bytes.toString('base64') !== input.content_base64) throw new AppError('Invalid base64 attachment.');
    return { filename: filename(input.filename || input.name || 'attachment'), bytes };
  }
  prepareComposition(userId, input, { scope, id } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('Content must be an object.');
    const body = text(input.body === undefined ? '' : input.body, 'Text', 12000, 0);
    const uploads = input.attachments ?? [];
    if (!Array.isArray(uploads) || uploads.length > 10) throw new AppError('Choose at most 10 attachments.');
    const removals = input.remove_attachment_ids ?? [];
    if (!Array.isArray(removals) || removals.length > 1000 || removals.some(value => !Number.isSafeInteger(value) || value < 1)) throw new AppError('Invalid attachment removals.');
    const existing = id ? this.store.all(`SELECT * FROM ticket_attachments WHERE scope=? AND ${scope === 'message' ? 'message_id' : 'comment_id'}=?`, scope, id) : [];
    const removed = [...new Set(removals)].map(value => {
      const row = existing.find(row => row.id === value && row.created_by === userId);
      if (!row) throw new AppError('Attachment removal does not belong to your content.', 403);
      return row;
    });
    const additions = uploads.map(upload => this.decodeUpload(upload));
    const kept = existing.filter(row => !removals.includes(row.id));
    if (additions.reduce((sum, file) => sum + file.bytes.length, 0) > maxBytes) throw new AppError('New attachments exceed 10 MiB combined.', 413);
    if (!body && kept.length + additions.length === 0) throw new AppError('Write some text or attach a file.');
    return { body, additions, removed };
  }
  atomicFiles(fn) {
    const files = { created: [], removed: [] };
    return this.store.transaction(() => {
      this.store.afterRollback(()=>{for(const path of files.created){try{unlinkSync(path);}catch{}}});
      this.store.afterCommit(()=>{for(const path of files.removed){try{unlinkSync(path);}catch{}}});
      return fn(files);
    });
  }
  applyComposition(userId, context, prepared, files) {
    for (const row of prepared.removed) {
      this.store.run('DELETE FROM ticket_attachments WHERE id=?', row.id);
      files.removed.push(join(this.uploadDir, row.file_key));
    }
    for (const upload of prepared.additions) {
      const fileKey = randomUUID(); const path = join(this.uploadDir, fileKey);
      files.created.push(path); writeFileSync(path, upload.bytes, { mode: 0o600, flag: 'wx' });
      this.store.run('INSERT INTO ticket_attachments(filename,file_key,mime_type,size,scope,ticket_id,comment_id,message_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        upload.filename, fileKey, imageType(upload.bytes), upload.bytes.length, context.scope, context.ticket_id || null,
        context.scope === 'comment' ? context.id : null, context.scope === 'message' ? context.id : null, userId, now());
    }
  }
  subscribe(userId, id, value) {
    this.actor(userId); const ticket = this.ticket(id);
    if (typeof value !== 'boolean') throw new AppError('Subscribed must be a boolean.');
    if (value) this.addSubscription(userId, ticket.id);
    else this.store.run('DELETE FROM ticket_subscriptions WHERE user_id=? AND ticket_id=?', userId, ticket.id);
    this.changed(ticket.id); return { subscribed: value };
  }
  publicAttachment(row) {
    const { file_key, ...metadata } = row;
    return { ...metadata, is_image: row.mime_type.startsWith('image/'), content_url: `/api/attachments/${row.id}/content` };
  }
  messageAttachments(id) {
    return this.store.all("SELECT * FROM ticket_attachments WHERE scope='message' AND message_id=? ORDER BY id", idValue(id, 'message')).map(row => this.publicAttachment(row));
  }
  attachments(userId, { ticket_id, comment_id, message_id } = {}) {
    this.actor(userId);
    let rows;
    if (message_id !== undefined) return this.messageAttachments(message_id);
    else if (comment_id !== undefined) rows = this.store.all('SELECT * FROM ticket_attachments WHERE comment_id=? ORDER BY id', idValue(comment_id, 'comment'));
    else if (ticket_id !== undefined) { this.ticket(ticket_id); rows = this.store.all('SELECT * FROM ticket_attachments WHERE ticket_id=? ORDER BY id', Number(ticket_id)); }
    else rows = [];
    return rows.map(row => this.publicAttachment(row));
  }
  attachment(userId, id) {
    this.actor(userId); const row = this.store.get('SELECT * FROM ticket_attachments WHERE id=?', idValue(id, 'attachment'));
    if (!row) throw new AppError('Attachment not found.', 404);
    return { ...this.publicAttachment(row), disk_path: join(this.uploadDir, row.file_key) };
  }
  readAttachment(userId, id) {
    const { disk_path, ...attachment } = this.attachment(userId, id);
    return { attachment, mime_type: attachment.mime_type, content_base64: readFileSync(disk_path).toString('base64') };
  }
  attach(userId, input, depth = 0) {
    const { bytes } = this.decodeUpload(input);
    return this.saveAttachment(userId, input, bytes, depth);
  }
  saveAttachment(userId, input, bytes, depth = 0) {
    this.actor(userId);
    if (bytes.length > maxBytes) throw new AppError('Attachment exceeds 10 MiB.', 413);
    const name = filename(input.filename || input.name || 'attachment');
    const scope = input.scope || (input.message_id ? 'message' : input.comment_id ? 'comment' : input.ticket_id ? 'ticket' : undefined);
    if (!['message', 'ticket', 'comment'].includes(scope)) throw new AppError('Choose a message, ticket or comment attachment scope.');
    let ticketId = input.ticket_id == null ? null : idValue(input.ticket_id, 'ticket');
    const commentId = input.comment_id == null ? null : idValue(input.comment_id, 'comment');
    const messageId = input.message_id == null ? null : idValue(input.message_id, 'message');
    let message;
    if (scope === 'message') {
      if (!messageId || ticketId || commentId) throw new AppError('Message attachments require only a message ID.');
      message = this.store.message(messageId);
      if (!message) throw new AppError('Message not found.', 404);
      if (message.user_id !== userId) throw new AppError('Only the message author can attach files to it.', 403);
    } else if (messageId) throw new AppError('Ticket and comment attachments cannot belong to a chat message.');
    if (scope === 'ticket' && (!ticketId || commentId)) throw new AppError('Ticket attachments require only a ticket ID.');
    if (scope === 'comment') {
      const comment = commentId && this.store.get('SELECT * FROM ticket_comments WHERE id=?', commentId);
      if (!comment || (ticketId && comment.ticket_id !== ticketId)) throw new AppError('Comment does not belong to this ticket.');
      // A commenter owns their attachments; other users attach files in their own comments.
      if (comment.user_id !== userId) throw new AppError('Only the comment author can attach files to it.', 403);
      ticketId = comment.ticket_id;
    }
    if (ticketId) this.ticket(ticketId);
    const fileKey = randomUUID(); const path = join(this.uploadDir, fileKey);
    const id = this.atomicFiles(files => {
        files.created.push(path); writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
        const id = Number(this.store.run('INSERT INTO ticket_attachments(filename,file_key,mime_type,size,scope,ticket_id,comment_id,message_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', name, fileKey, imageType(bytes), bytes.length, scope, ticketId, commentId, messageId, userId, now()).lastInsertRowid);
        if (ticketId) {
          if (commentId) this.store.run('UPDATE ticket_comments SET version=version+1,edited_at=? WHERE id=?', now(), commentId);
          this.store.run('UPDATE tickets SET updated_at=?,version=version+1 WHERE id=?', now(), ticketId);
          this.record(userId, ticketId, 'attached', `Attached ${name}.`, { attachment_id: id, comment_id: commentId }, depth);
        }
        if (message) {
          this.store.run('UPDATE messages SET version=version+1,edited_at=? WHERE id=?', now(), messageId);
          this.store.inbox.message(userId, messageId, 'message_attachment', Math.max(message.depth, Number(depth) || 0), message.body);
        }
        return id;
      });
    if (messageId) { this.store.onChange('message', this.store.message(messageId)); this.store.inbox.changed(); }
    else this.changed(ticketId);
    const { disk_path, ...attachment } = this.attachment(userId, id);
    return { ...attachment, ticket_version: ticketId ? this.ticket(ticketId).version : null,
      ...(messageId ? { message_version: this.store.message(messageId).version } : {}),
      ...(commentId ? { comment_version: this.store.get('SELECT version FROM ticket_comments WHERE id=?', commentId).version } : {}) };
  }
  importFile(userId, input, root, depth = 0) {
    this.actor(userId);
    const bytes = readWorkspaceBinary(root, input.path, maxBytes);
    return this.saveAttachment(userId, { ...input, filename: input.name || basename(input.path) }, bytes, depth);
  }
  notifications(userId) {
    return this.store.inbox.list(userId);
  }
  markRead(userId, ids) {
    return this.store.inbox.markRead(userId, ids);
  }
}
