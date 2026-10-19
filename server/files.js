import { lstatSync, fstatSync, ftruncateSync, readSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, rmdirSync, openSync, closeSync, constants } from 'node:fs';
import { resolve, relative, sep, dirname } from 'node:path';
import { AppError } from './store.js';

const maxBytes = 256 * 1024;
// Reject symlinks in user paths; sensitive operations additionally anchor parent descriptors.
export class WorkspaceFiles {
  constructor(root) { this.root = resolve(root); }
  path(value = '.', { missing = false } = {}) {
    if (typeof value !== 'string' || value.includes('\0') || value.length > 1024) throw new AppError('Invalid workspace path.');
    const target = resolve(this.root, value);
    const rel = relative(this.root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new AppError('Path must stay inside your workspace.', 403);
    if (rel.split(sep).includes('.codex')) throw new AppError('The .codex configuration directory is reserved.', 403);
    const parts = target.split(sep).filter(Boolean);
    let current = sep;
    for (const part of parts) {
      current = resolve(current, part);
      let stat;
      try { stat = lstatSync(current); } catch (error) {
        if (error.code === 'ENOENT' && missing) continue;
        if (error.code === 'ENOENT') throw new AppError('File or directory not found.', 404);
        throw error;
      }
      if (stat.isSymbolicLink()) throw new AppError('Symbolic links are unavailable to agents.', 403);
    }
    return target;
  }
  tool(name, input) {
    switch (name) {
      case 'list_files': {
        const target = this.path(input.path);
        const entries = withWorkspaceParent(this.root, input.path || '.', path => {
          const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { return readdirSync(`/proc/self/fd/${fd}`, { withFileTypes: true }); } finally { closeSync(fd); }
        });
        return { path: relative(this.root, target) || '.', entries: entries.slice(0, 500).map(e => ({
          name: e.name, type: e.isSymbolicLink() ? 'blocked_symlink' : e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other'
        })), truncated: entries.length > 500 };
      }
      case 'read_file': {
        return { path: relative(this.root, this.path(input.path)), content: readWorkspaceBinary(this.root, input.path, maxBytes).toString('utf8') };
      }
      case 'write_file': {
        if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > maxBytes) throw new AppError('Content must be UTF-8 text up to 256 KiB.');
        return writeWorkspaceBinary(this.root, input.path, input.content, { overwrite: true });
      }
      case 'create_directory': {
        return withWorkspaceParent(this.root, input.path, (path, target, isRoot) => {
          if (!isRoot) { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
          const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); closeSync(fd);
          return { path: relative(this.root, target) || '.' };
        }, { parents: true });
      }
      case 'move_file': {
        const from = this.path(input.path), to = this.path(input.destination, { missing: true });
        if (from === this.root || to === this.root) throw new AppError('The workspace root cannot be moved or replaced.');
        this.path(dirname(to));
        try { lstatSync(to); throw new AppError('Destination already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        return withWorkspaceParent(this.root, input.path, source => withWorkspaceParent(this.root, input.destination, destination => {
          try { lstatSync(destination); throw new AppError('Destination already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          renameSync(source, destination); return { path: relative(this.root, to) };
        }));
      }
      case 'delete_file': {
        const target = this.path(input.path);
        if (target === this.root) throw new AppError('The workspace root cannot be deleted.');
        withWorkspaceParent(this.root, input.path, path => { if (lstatSync(path).isDirectory()) rmdirSync(path); else unlinkSync(path); });
        return { deleted: true };
      }
      default: throw new AppError('Unknown workspace tool.', 404);
    }
  }
}

// Linux descriptor-relative traversal prevents concurrently executing agents from
// swapping a checked parent for a symlink between validation and filesystem I/O.
function withWorkspaceParent(root, value, action, { parents = false } = {}) {
  const files = new WorkspaceFiles(root);
  const target = files.path(value, { missing: true });
  const parts = relative(files.root, target).split(sep).filter(Boolean);
  const descriptors = [];
  try {
    let fd = openSync(files.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); descriptors.push(fd);
    for (const part of parts.slice(0, -1)) {
      const path = `/proc/self/fd/${fd}/${part}`;
      if (parents) { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
      fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); descriptors.push(fd);
    }
    return action(parts.length ? `/proc/self/fd/${fd}/${parts.at(-1)}` : `/proc/self/fd/${fd}/.`, target, parts.length === 0);
  } finally { for (const fd of descriptors.reverse()) closeSync(fd); }
}

export function readWorkspaceBinary(root, path, maxBytes = 10 * 1024 * 1024) {
  return withWorkspaceParent(root, path, target => {
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new AppError(`Only regular files without hard links up to ${maxBytes} bytes can be read.`);
      const output = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
      let offset = 0, size;
      while (offset < output.length && (size = readSync(fd, output, offset, output.length - offset, null)) > 0) offset += size;
      if (offset > maxBytes || offset > stat.size) throw new AppError('File changed while it was being read; try again.');
      return output.subarray(0, offset);
    } finally { closeSync(fd); }
  });
}

export function writeWorkspaceBinary(root, path, bytes, { overwrite = false } = {}) {
  return withWorkspaceParent(root, path, (target, absolute, isRoot) => {
    if (isRoot) throw new AppError('Choose a file inside your workspace.');
    const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | (overwrite ? 0 : constants.O_EXCL), 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new AppError('Only regular files without hard links may be written.');
      ftruncateSync(fd, 0); writeFileSync(fd, bytes);
    } finally { closeSync(fd); }
    return { path: relative(resolve(root), absolute), bytes: Buffer.byteLength(bytes) };
  });
}
