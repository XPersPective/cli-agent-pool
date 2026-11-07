// Native permission/settings files that decide what a CLI run may do. Their
// content hashes key the preflight cache and join the workspace fingerprint
// (they are often gitignored, so git status alone would miss a new grant).
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { agyProjectMatches } from './agy-project.js';
import { claudeConfigDirectory, profileDirectory, profileHome } from './profiles.js';

const FILE_LIMIT = 4_194_304;

function claudeManagedSettings() {
  if (process.platform === 'win32') return path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json');
  return process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json';
}

function listFiles(directory) {
  try { return readdirSync(directory).sort().map(name => path.join(directory, name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Worktrees and tasks rooted in repository subdirectories share the real
// repository config. .git/config at the submitted root is often not that file.
export function repositorySettings(workspace) {
  for (let current = workspace; ; current = path.dirname(current)) {
    const marker = path.join(current, '.git');
    let info;
    try { info = lstatSync(marker); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info) {
      if (info.isSymbolicLink()) throw new Error('Git metadata must not be a symbolic link.');
      let gitDir = marker;
      if (info.isFile()) {
        const match = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(marker, 'utf8'));
        if (!match) throw new Error('Invalid gitdir marker.');
        gitDir = path.resolve(current, match[1].trim());
      } else if (!info.isDirectory()) throw new Error('Invalid git metadata.');
      let common = gitDir;
      try { common = path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return [...new Set([path.join(common, 'config'), path.join(common, 'config.worktree'), path.join(gitDir, 'config.worktree')])];
    }
    if (path.dirname(current) === current) return [];
  }
}

export function nativeSettingsFiles(route, workspace, directory, home = homedir()) {
  const files = repositorySettings(workspace);
  if (route?.adapter === 'claude') {
    files.push(path.join(workspace, '.claude', 'settings.json'), path.join(workspace, '.claude', 'settings.local.json'),
      path.join(claudeConfigDirectory(route, directory, home), 'settings.json'), claudeManagedSettings());
  } else if (route?.adapter === 'codex') {
    const codexHome = route.profile ? profileDirectory(route, directory) : process.env.CODEX_HOME || path.join(home, '.codex');
    files.push(...listFiles(path.join(codexHome, 'rules')));
  } else if (route?.adapter === 'agy' && route.runtime !== 'wsl') {
    const agyHome = directory ? profileHome(route, directory, home) : home;
    const matches = agyProjectMatches(workspace, agyHome);
    files.push(...(matches.length ? matches : agyProjectMatches(workspace, home)).map(match => match.file),
      path.join(agyHome, '.gemini', 'config', 'config.json'), path.join(agyHome, '.gemini', 'config', 'mcp_config.json'));
  }
  return [...new Set(files)];
}

export function fileDigest(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Settings or metadata is not a regular file.');
    if (stat.size > FILE_LIMIT) throw new Error('Settings or metadata exceeds fingerprint size limit.');
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'absent'; throw error; }
}

export function settingsDigest(files) {
  return files.map(file => `${file}\0${fileDigest(file)}`).join('\n');
}
