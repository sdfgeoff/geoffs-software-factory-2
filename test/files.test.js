import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, symlink, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceFiles } from '../server/files.js';

test('agent folder starts empty and supports scoped file roundtrips', async t => {
  const root = await mkdtemp(join(tmpdir(), 'commonroom-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new WorkspaceFiles(root);
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(files.tool('list_files', {}).entries, []);
  files.tool('create_directory', { path: 'notes' });
  files.tool('write_file', { path: 'notes/idea.txt', content: 'An idea ✨' });
  assert.equal(files.tool('read_file', { path: 'notes/idea.txt' }).content, 'An idea ✨');
  files.tool('move_file', { path: 'notes/idea.txt', destination: 'notes/renamed.txt' });
  assert.throws(() => files.tool('delete_file', { path: 'notes' }));
  files.tool('delete_file', { path: 'notes/renamed.txt' });
  files.tool('delete_file', { path: 'notes' });
  assert.deepEqual(files.tool('list_files', {}).entries, []);
});

test('file tools block traversal, symlink escape, reserved settings and unsafe replacement', async t => {
  const base = await mkdtemp(join(tmpdir(), 'commonroom-files-safety-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'workspace'); const outside = join(base, 'outside');
  await mkdir(root); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'secret');
  const files = new WorkspaceFiles(root);
  await symlink(outside, join(root, 'linked'));
  for (const path of ['../outside/secret.txt', join(outside, 'secret.txt'), 'linked/secret.txt']) {
    assert.throws(() => files.tool('read_file', { path }), /inside your workspace|Symbolic links/);
    assert.throws(() => files.tool('write_file', { path, content: 'overwrite' }), /inside your workspace|Symbolic links/);
  }
  assert.throws(() => files.tool('create_directory', { path: '.codex/settings' }), /reserved/);
  assert.throws(() => files.tool('delete_file', { path: '.' }), /root cannot be deleted/);
  assert.throws(() => files.tool('write_file', { path: 'large', content: 'x'.repeat(256 * 1024 + 1) }), /256 KiB/);
  files.tool('write_file', { path: 'a', content: 'A' });
  files.tool('write_file', { path: 'b', content: 'B' });
  assert.throws(() => files.tool('move_file', { path: 'a', destination: 'b' }), /already exists/);
  assert.equal(files.tool('read_file', { path: 'b' }).content, 'B');
  assert.equal(files.tool('list_files', {}).entries.find(e => e.name === 'linked').type, 'blocked_symlink');
});
