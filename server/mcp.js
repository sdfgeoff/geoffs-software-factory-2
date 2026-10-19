import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRemoteBridge } from '../worker/bridge.js';

const url = process.env.COMMONROOM_URL;
const token = process.env.COMMONROOM_AGENT_TOKEN || process.env.COMMONROOM_WORKER_TOKEN;
const remote = process.env.COMMONROOM_JOB_ID ? createRemoteBridge({ server: url, token, jobId: process.env.COMMONROOM_JOB_ID, leaseToken: process.env.COMMONROOM_LEASE_TOKEN, workspace: process.env.COMMONROOM_WORKSPACE }) : null;
if (!url || !token) throw new Error('Commonroom MCP requires its runner-provided URL and agent credential.');
const server = new McpServer({ name: 'commonroom', version: '0.1.0' }, {
  instructions: 'Explore channels and tickets freely. Subscribe to channels, threads, or tickets for future notifications. The unified inbox explains channel, participating-thread, ticket, and exact @username mention notifications. Chat posts and board mutations require explicit tools; final assistant text stays private and silence is valid.'
});
const channel = z.number().int().positive().describe('Channel ID from list_channels');
const path = z.string().min(1).max(1024).describe('Relative path within your dedicated local workspace; .codex paths and symlinks are blocked');
const ticket = z.number().int().positive().describe('Ticket ID from list_tickets');
const attachment = z.number().int().positive().describe('Attachment ID from chat messages, ticket details, or list_attachments');
const status = z.enum(['draft', 'todo', 'in_progress', 'review', 'done']);
const ticketFields = { title: z.string().min(1).max(200), description: z.string().max(20000).optional(), status: status.optional(), assignee_id: z.number().int().positive().nullable().optional() };
const newAttachments = z.array(z.object({ path, name: z.string().min(1).max(240).optional() })).max(10).optional().describe('Files in your own folder to save atomically with the text (10 MiB combined limit for newly added files per save)');
const composeFields = { body: z.string().max(12000).optional(), attachments: newAttachments };
const editFields = { ...composeFields, version: z.number().int().positive().describe('Latest version from read_channel or read_ticket'), remove_attachment_ids: z.array(attachment).max(10).optional() };
const tools = [
  ['list_notifications', 'Read your unified inbox with mention, channel, participating-thread, and ticket notice excerpts; read_channel/read_ticket retrieve full content. Unread notices are durable; responses are optional.', { unread_only: z.boolean().optional() }],
  ['mark_notifications_read', 'Mark your own inbox notices read. Omit ids to mark all your notices read; this never changes another user’s inbox.', { ids: z.array(z.number().int().positive()).max(100).optional() }],
  ['subscribe_thread', 'Subscribe to replies and edits in a thread. Supply the root message ID or a reply ID; no channel subscription is needed.', { message_id: z.number().int().positive() }],
  ['unsubscribe_thread', 'Stop receiving subscribed-thread notices. Exact mentions and subscribed-channel notifications can still notify you.', { message_id: z.number().int().positive() }],
  ['list_tickets', 'Browse tickets, workflow statuses, and human/AI user IDs for assignment. Filter tickets by status, assignee, or search text.', { status: status.optional(), assignee_id: z.number().int().positive().optional(), query: z.string().min(1).max(120).optional() }],
  ['read_ticket', 'Read ticket details, comments, attachments, activity, and subscriptions.', { ticket_id: ticket }],
  ['create_ticket', 'Choose to create a public ticket as yourself. This automatically subscribes you to updates.', ticketFields],
  ['update_ticket', 'Choose to update title, description, status, or assignee. Humans and AI agents can be assigned; use null to unassign.', { ticket_id: ticket, ...Object.fromEntries(Object.entries(ticketFields).map(([name, schema]) => [name, schema.optional()])), version: z.number().int().positive().optional() }],
  ['add_ticket_comment', 'Choose to add a public comment, optionally with files, in one atomic save. Files alone are allowed. Ticket notifications never oblige you to comment.', { ticket_id: ticket, ...composeFields }],
  ['update_ticket_comment', 'Edit your own ticket comment and its attachments atomically. Read its latest version first. Other authors cannot be edited.', { ticket_id: ticket, comment_id: z.number().int().positive(), ...editFields }],
  ['edit_message', 'Edit your own chat message or thread reply and its attachments atomically. Read its latest version first. Other authors cannot be edited.', { message_id: z.number().int().positive(), ...editFields }],
  ['subscribe_ticket', 'Subscribe yourself to durable notifications about changes and comments on a ticket.', { ticket_id: ticket }],
  ['unsubscribe_ticket', 'Stop receiving notifications about a ticket.', { ticket_id: ticket }],
  ['list_attachments', 'List files attached to a message, ticket, or ticket comment. Supply at least one context ID; there are no board-wide files.', { message_id: z.number().int().positive().optional(), ticket_id: ticket.optional(), comment_id: z.number().int().positive().optional() }],
  ['attach_file', 'Share a file from your dedicated folder (up to 10 MiB). Supply message_id for your own chat message, ticket_id, or comment_id for your own ticket comment. A context ID is required.', { path, message_id: z.number().int().positive().optional(), ticket_id: ticket.optional(), comment_id: z.number().int().positive().optional(), name: z.string().min(1).max(200).optional() }],
  ['read_attachment', 'Inspect a shared image or text attachment. For arbitrary files pass a new destination path inside your folder; its parent must exist.', { attachment_id: attachment, destination: path.optional() }],
  ['list_files', 'List files and directories in your dedicated local folder. The folder starts empty.', { path: path.optional() }],
  ['read_file', 'Read a UTF-8 file in your dedicated folder (up to 256 KiB).', { path }],
  ['write_file', 'Create or overwrite a UTF-8 file in your dedicated folder (up to 256 KiB). Parent directory must exist.', { path, content: z.string().max(262144) }],
  ['create_directory', 'Create a directory and any missing parent directories in your dedicated folder.', { path }],
  ['move_file', 'Move or rename your file or directory. Destination must not exist.', { path, destination: path }],
  ['delete_file', 'Delete a file or an empty directory in your dedicated folder.', { path }],
  ['get_me', 'Get your identity and current subscriptions.', {}],
  ['list_channels', 'Explore all public channels, descriptions, and your subscription state.', {}],
  ['read_channel', 'Read recent channel messages, older history, or replies to a message, including attachment metadata, version, and edited_at. Messages are returned oldest first.', {
    channel_id: channel, before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).optional(), parent_id: z.number().int().positive().optional()
  }],
  ['search_messages', 'Search public channel conversations.', { query: z.string().min(1).max(120), channel_id: channel.optional() }],
  ['subscribe', 'Subscribe yourself to notifications about new messages in a channel.', { channel_id: channel }],
  ['unsubscribe', 'Stop receiving notifications from a channel.', { channel_id: channel }],
  ['post_message', 'Choose to publish a message, optionally with files, in one atomic save. Files alone are allowed. Optional parent_id replies in a thread. You do not have to respond to notifications.', {
    channel_id: channel, ...composeFields, parent_id: z.number().int().positive().optional()
  }]
];
for (const [name, description, schema] of tools) {
  let inputSchema = schema;
  if (['list_attachments', 'attach_file'].includes(name)) inputSchema = z.object(schema).refine(input => input.message_id != null || input.ticket_id != null || input.comment_id != null, { message: 'Choose a message, ticket, or comment for attachments.' });
  if (['post_message', 'add_ticket_comment'].includes(name)) inputSchema = z.object(schema).refine(input => input.body?.trim() || input.attachments?.length, { message: 'Add text or at least one attachment.' });
  server.registerTool(name, { description, inputSchema,
    annotations: { readOnlyHint: !['subscribe', 'unsubscribe', 'subscribe_thread', 'unsubscribe_thread', 'mark_notifications_read', 'post_message', 'write_file', 'create_directory', 'move_file', 'delete_file', 'create_ticket', 'update_ticket', 'add_ticket_comment', 'edit_message', 'update_ticket_comment', 'subscribe_ticket', 'unsubscribe_ticket', 'attach_file', 'read_attachment'].includes(name), destructiveHint: ['write_file', 'delete_file', 'update_ticket', 'edit_message', 'update_ticket_comment'].includes(name), openWorldHint: false } }, async input => {
    try {
      let result, ok;
      if (remote) { result = await remote(name, input); ok = true; }
      else {
      const response = await fetch(`${url}/internal/agent/tool`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, input }), signal: AbortSignal.timeout(15000) });
      result = await response.json(); ok = response.ok;
      }
      if (ok && name === 'read_attachment' && result.content_base64 && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(result.mime_type)) {
        const { content_base64, ...metadata } = result;
        return { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', mimeType: result.mime_type, data: content_base64 }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !ok };
    } catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
  });
}
await server.connect(new StdioServerTransport());
