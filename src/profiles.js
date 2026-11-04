// Account profiles: one official CLI login per route, kept by the CLI itself.
// The Pool only points each CLI at its own directory; it never reads, copies
// or moves credential contents between profiles.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const profileAdapters = new Set(['codex', 'claude']);

export function profileDirectory(route, directory) {
  return path.join(directory, 'profiles', route.adapter, route.profile);
}

export function profileEnvironment(route, directory, create = true) {
  if (!route.profile || route.api || !profileAdapters.has(route.adapter)) return {};
  const target = profileDirectory(route, directory);
  if (create) mkdirSync(target, { recursive: true, mode: 0o700 });
  return route.adapter === 'codex' ? { CODEX_HOME: target } : { CLAUDE_CONFIG_DIR: target };
}

export function claudeConfigDirectory(route, directory, home = homedir()) {
  return route.profile && !route.api ? profileDirectory(route, directory) : path.join(home, '.claude');
}

export const wslExecutable = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');

export function wslProfileHome(route) {
  return `${route.wsl.home}/.cli-agent-pool/profiles/agy/${route.profile || 'default'}`;
}

// Windows path of a file inside the WSL distribution (\\wsl.localhost\<distro>\...).
export function wslWindowsPath(route, linuxPath) {
  return `\\\\wsl.localhost\\${route.wsl.distro}${linuxPath.replace(/\//g, '\\')}`;
}

export function wslPrefix(route) {
  return [wslExecutable(), '-d', route.wsl.distro, '--exec', '/usr/bin/env', `HOME=${wslProfileHome(route)}`];
}

// D:\repo\x -> /mnt/d/repo/x. Other path forms have no WSL equivalent here.
export function windowsToWsl(value) {
  const match = /^([a-zA-Z]):[\\/]*(.*)$/.exec(value || '');
  if (!match) return null;
  const rest = match[2].replace(/\\/g, '/').replace(/\/+$/, '');
  return `/mnt/${match[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

export function wslToWindows(value) {
  const match = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(value || '');
  return match ? `${match[1].toUpperCase()}:\\${(match[2] || '').replace(/\//g, '\\')}` : null;
}

// file:///mnt/d/repo -> D:\repo, used to match mirrored WSL projects to Windows workspaces.
export function wslUriToWindows(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:///mnt/')) return null;
  return wslToWindows(decodeURIComponent(new URL(uri).pathname));
}

function windowsUriToWsl(uri) {
  try { return windowsToWsl(fileURLToPath(uri)); } catch { /* not a Windows file URI */ }
  const decoded = /^file:\/\/\/([a-zA-Z])(?:%3A|:)\/(.*)$/i.exec(uri || '');
  return decoded ? windowsToWsl(`${decoded[1]}:/${decodeURIComponent(decoded[2])}`) : null;
}

const encodeWslUri = linuxPath => `file://${linuxPath.split('/').map(encodeURIComponent).join('/')}`;

function readJson(file) {
  try { const value = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); return value && typeof value === 'object' ? value : null; }
  catch { return null; }
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.pool-${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, file);
}

const mapGrant = grant => {
  const match = /^(read_file|write_file)\((.+)\)$/.exec(grant);
  if (!match) return grant;
  const translated = windowsToWsl(match[2]);
  return translated ? `${match[1]}(${translated})` : null;
};

// Mirror the owner's native Antigravity project permissions and trusted folders
// into a WSL profile, translating Windows paths to /mnt paths. Owner actions call
// this (login, catalog refresh, service start); task submission never does.
// Credentials and conversations are not part of these files.
export function mirrorAgyPermissions(targetGeminiDir, sourceHome = homedir()) {
  const sourceGemini = path.join(sourceHome, '.gemini');
  let projects = 0;
  const sourceProjects = path.join(sourceGemini, 'config', 'projects');
  let files = [];
  try { files = readdirSync(sourceProjects).filter(file => /^[A-Za-z0-9_.-]{1,120}\.json$/.test(file)); } catch { /* no native projects */ }
  for (const file of files) {
    const project = readJson(path.join(sourceProjects, file));
    const resources = project?.projectResources?.resources;
    if (!project || typeof project.id !== 'string' || !Array.isArray(resources)) continue;
    const mapped = resources.flatMap(resource => {
      const linuxPath = windowsUriToWsl(resource?.gitFolder?.folderUri ?? resource?.folderUri);
      if (!linuxPath) return [];
      const folderUri = encodeWslUri(linuxPath);
      return [resource.gitFolder ? { ...resource, gitFolder: { ...resource.gitFolder, folderUri } } : { ...resource, folderUri }];
    });
    if (!mapped.length) continue;
    writeJsonAtomic(path.join(targetGeminiDir, 'config', 'projects', file), { ...project, projectResources: { ...project.projectResources, resources: mapped } });
    projects++;
  }
  const source = readJson(path.join(sourceGemini, 'antigravity-cli', 'settings.json')) || {};
  const targetFile = path.join(targetGeminiDir, 'antigravity-cli', 'settings.json');
  const target = readJson(targetFile) || {};
  const union = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...b])];
  const allow = (source.permissions?.allow || []).filter(item => typeof item === 'string').map(mapGrant).filter(Boolean);
  const deny = (source.permissions?.deny || []).filter(item => typeof item === 'string').map(mapGrant).filter(Boolean);
  const trusted = (source.trustedWorkspaces || []).map(item => windowsToWsl(item)).filter(Boolean);
  const next = { ...target, permissions: { ...(target.permissions || {}), allow: union(target.permissions?.allow, allow), ...(deny.length || target.permissions?.deny ? { deny: union(target.permissions?.deny, deny) } : {}) }, trustedWorkspaces: union(target.trustedWorkspaces, trusted) };
  if (JSON.stringify(next) !== JSON.stringify(target) || !existsSync(targetFile)) writeJsonAtomic(targetFile, next);
  return { projects, grants: allow.length, trusted: trusted.length };
}
