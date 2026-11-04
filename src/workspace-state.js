// Workspace change fingerprint. A failed write task keeps its review lock only
// when the workspace actually changed; any doubt yields "unknown", which never
// matches, so the lock stays.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from './process.js';
import { fileDigest, settingsDigest } from './native-settings.js';

const WALK_LIMIT = 20_000;
const STATUS_LIMIT = 20_000;
const CONTENT_LIMIT = 67_108_864;

async function git(args, cwd, python) {
  const result = await runProcess({ argv: ['git', '-c', 'core.quotepath=false', '-c', 'status.relativePaths=false', '-C', cwd, ...args], cwd, python, timeoutMs: 60_000, maxBytes: 33_554_432 }).done;
  if (result.stopReason || result.code !== 0) throw new Error(`git ${args[0]} failed`);
  return result.output;
}

function stat(file) {
  const s = lstatSync(file);
  if (s.isSymbolicLink()) throw new Error('Cannot fingerprint symbolic link content.');
  return `${s.isDirectory() ? 'd' : 'f'}:${s.size}:${Math.trunc(s.mtimeMs * 1000)}`;
}

// Non-git workspaces: bounded path/size/mtime walk; nothing is skipped.
function walk(root, entries) {
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    const names = readdirSync(directory).sort();
    for (const name of names) {
      const file = path.join(directory, name);
      const value = stat(file);
      entries.push(`${path.relative(root, file)}\0${value}`);
      if (entries.length > WALK_LIMIT) throw new Error('walk limit');
      if (value.startsWith('d:')) stack.push(file);
    }
  }
}

// Repository metadata that changes behaviour without showing in git status:
// config (hooksPath, credential helpers), info/exclude (hides files) and hooks.
function gitMetadata(gitDir, hooksDir) {
  const files = [path.join(gitDir, 'config')];
  for (const directory of [path.join(gitDir, 'info'), hooksDir]) {
    try { for (const name of readdirSync(directory).sort()) files.push(path.join(directory, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files.map(file => `${file}\0${fileDigest(file)}`).join('\n');
}

export async function workspaceFingerprint(workspace, python, settingsFiles = []) {
  const hash = createHash('sha256');
  try {
    hash.update(`settings\0${settingsDigest(settingsFiles)}\0`);
    let inside = false;
    try { inside = (await git(['rev-parse', '--is-inside-work-tree'], workspace, python)).trim() === 'true'; } catch { inside = false; }
    if (inside) {
      // Independent reads run in parallel; HEAD may not exist in a fresh repository (a state, not an error).
      const [head, branch, refs, stash, status, flags, staged, top, commonDir, hooksPath] = await Promise.all([
        git(['rev-parse', '--verify', '-q', 'HEAD'], workspace, python).catch(() => 'none'),
        git(['symbolic-ref', '-q', 'HEAD'], workspace, python).catch(() => 'detached'),
        git(['for-each-ref', '--format=%(refname) %(objectname)'], workspace, python),
        git(['stash', 'list', '--format=%H'], workspace, python).catch(() => ''),
        git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none', '--', '.'], workspace, python),
        git(['ls-files', '--full-name', '-v', '-z', '--', '.'], workspace, python),
        git(['ls-files', '--full-name', '--stage', '-z', '--', '.'], workspace, python),
        git(['rev-parse', '--show-toplevel'], workspace, python).then(value => value.trim()),
        git(['rev-parse', '--git-common-dir'], workspace, python),
        git(['rev-parse', '--git-path', 'hooks'], workspace, python),
      ]);
      const gitDir = path.resolve(workspace, commonDir.trim());
      if (staged.split('\0').some(entry => entry.startsWith('120000 '))) return 'unknown';
      // Hidden tracked files need content hashes too: their status remains clean
      // after edits under assume-unchanged or skip-worktree.
      const hidden = flags.split('\0').filter(line => line && !line.startsWith('H '));
      hash.update(`git\0${head.trim()}\0${branch.trim()}\0${refs}\0${stash}\0${status}\0${flags}\0${staged}\0${gitMetadata(gitDir, path.resolve(workspace, hooksPath.trim()))}\0`);
      const entries = status.split('\0').filter(Boolean);
      if (entries.length > STATUS_LIMIT) return 'unknown';
      let bytes = 0;
      const paths = [];
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        // Rename sources follow their entry without a status prefix; content of the target suffices.
        if (!/^[ MADRCU?!]{2} /.test(entry)) continue;
        paths.push(entry.slice(3));
        if (/[RC]/.test(entry.slice(0, 2))) index++;
      }
      paths.push(...hidden.map(line => line.slice(2)));
      if (paths.length > STATUS_LIMIT) return 'unknown';
      for (const name of new Set(paths)) {
        const file = path.join(top, name);
        let info;
        try { info = lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; hash.update(`${name}\0absent\0`); continue; }
        if (info.isDirectory()) return 'unknown'; // nested repository or submodule
        if (info.isSymbolicLink()) return 'unknown';
        bytes += info.size;
        if (bytes > CONTENT_LIMIT) return 'unknown';
        hash.update(`${name}\0${createHash('sha256').update(readFileSync(file)).digest('hex')}\0`);
      }
      return `git:${hash.digest('hex')}`;
    }
    const entries = [];
    walk(workspace, entries);
    hash.update(entries.join('\n'));
    return `walk:${hash.digest('hex')}`;
  } catch { return 'unknown'; }
}

export const workspaceUnchanged = (before, after) => Boolean(before) && before !== 'unknown' && before === after;
