#!/usr/bin/env node
// Deterministic Codex app-server fixture: real worker/MCP/container transport, no inference.
import { createInterface } from 'node:readline';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let threadParams;
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);
const event = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);
async function executeTurn(threadId, turnId) {
  let client;
  try {
    if (threadParams.sandbox !== 'danger-full-access' || threadParams.approvalPolicy !== 'never') throw new Error('Worker did not grant configured full access.');
    const cwd = threadParams.cwd;
    mkdirSync(cwd, { recursive: true });
    const proof = join(cwd, 'container-proof.txt');
    if (!existsSync(proof)) {
      const config = threadParams.config.mcp_servers.commonroom;
      client = new Client({ name: 'commonroom-container-test', version: '1.0.0' });
      await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...process.env, ...config.env }, stderr: 'pipe' }));
      const written = await client.callTool({ name: 'write_file', arguments: { path: 'container-proof.txt', content: 'COMMONROOM_CONTAINER_FILE_OK' } });
      if (written.isError) throw new Error('Worker MCP file write failed.');
      if (!existsSync(proof)) throw new Error('File tool did not write in worker workspace.');
      const posted = await client.callTool({ name: 'post_message', arguments: {
        channel_id: Number(process.env.FAKE_WORKER_CHANNEL_ID || 1), body: 'COMMONROOM_CONTAINER_WORKER_OK',
        attachments: [{ path: 'container-proof.txt' }],
      } });
      if (posted.isError) throw new Error(`Remote post failed: ${JSON.stringify(posted.content)}`);
    }
    writeFileSync(join(cwd, 'last-turn.json'), JSON.stringify({ sandbox: threadParams.sandbox, thread_id: threadId, cwd }));
    event('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  } catch (error) {
    event('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: error.message } } });
  } finally { await client?.close(); }
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  switch (message.method) {
    case 'initialize': reply(message.id, { serverInfo: { name: 'fake-codex', version: '1' } }); break;
    case 'account/read': reply(message.id, { account: { type: 'chatgpt', planType: 'test' } }); break;
    case 'model/list': reply(message.id, { data: [{ model: 'fake-test', displayName: 'Fake test model', isDefault: true }] }); break;
    case 'thread/start':
    case 'thread/resume':
      threadParams = message.params;
      reply(message.id, { thread: { id: message.params.threadId || randomUUID() }, model: 'fake-test' }); break;
    case 'turn/start': {
      const id = randomUUID(); reply(message.id, { turn: { id, status: 'inProgress' } });
      setTimeout(() => executeTurn(message.params.threadId, id), 0); break;
    }
    case 'turn/interrupt': reply(message.id, {}); break;
    default: reply(message.id, {});
  }
});
