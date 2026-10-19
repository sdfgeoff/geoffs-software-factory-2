import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { WorkspaceFiles, readWorkspaceBinary, writeWorkspaceBinary } from '../server/files.js';

export function createRemoteBridge({ server, token, jobId, leaseToken, workspace, fetchImpl = fetch }) {
  const request = async (name, input) => {
    const body = JSON.stringify({ lease_token: leaseToken, request_id: randomUUID(), name, input });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetchImpl(`${server}/api/workers/jobs/${jobId}/tool`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(30000) });
        const result = await response.json();
        if (!response.ok) { const error = new Error(result.error || `Worker tool failed (${response.status}).`); error.status = response.status; throw error; }
        return result;
      } catch (error) {
        if ((error.status && error.status < 500) || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt));
      }
    }
  };
  const upload = file => {
    if (!file || typeof file.path !== 'string') throw new Error('Each attachment needs a path inside your worker folder.');
    const bytes = readWorkspaceBinary(workspace, file.path, 10 * 1024 * 1024);
    return { filename: file.name || basename(file.path), content_base64: bytes.toString('base64') };
  };
  return async (name, input = {}) => {
    if (['list_files','read_file','write_file','create_directory','move_file','delete_file'].includes(name)) return new WorkspaceFiles(workspace).tool(name, input);
    if (name === 'attach_file') {
      const { message_id, ticket_id, comment_id } = input;
      if (message_id == null && ticket_id == null && comment_id == null) throw new Error('Choose a message, ticket, or comment for attachments.');
      return request('attach_bytes', { ...upload(input), message_id, ticket_id, comment_id });
    }
    if (['post_message','add_ticket_comment','edit_message','update_ticket_comment'].includes(name) && input.attachments !== undefined) {
      if (!Array.isArray(input.attachments) || input.attachments.length > 10) throw new Error('Use at most 10 new files per save.');
      const attachments = input.attachments.map(upload);
      if (attachments.reduce((size, file) => size + Buffer.from(file.content_base64, 'base64').length, 0) > 10 * 1024 * 1024) throw new Error('New attachments exceed 10 MiB combined.');
      input = { ...input, attachments };
    }
    if (name === 'read_attachment') {
      const result = await request(name, { attachment_id: input.attachment_id });
      const bytes = Buffer.from(result.content_base64, 'base64');
      if (input.destination) return { attachment: result.attachment, path: writeWorkspaceBinary(workspace, input.destination, bytes).path };
      if (['image/png','image/jpeg','image/gif','image/webp'].includes(result.mime_type)) return result;
      if (/^(text\/|application\/(json|xml|javascript))/.test(result.mime_type) && bytes.length <= 262144) return { attachment: result.attachment, text: bytes.toString('utf8') };
      return { attachment: result.attachment, note: 'Pass destination to download this file into your worker folder.' };
    }
    return request(name, input);
  };
}
