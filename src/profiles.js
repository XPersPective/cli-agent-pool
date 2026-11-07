// Account profiles: one official CLI login per route, kept by the CLI itself.
// The Pool only points each CLI at its own directory; it never reads, copies
// or moves credential contents between profiles.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const profileAdapters = new Set(['codex', 'claude']);
// These CLIs keep their login in files under the user home (~/.zcode, ~/.qwen,
// ~/.kimi-code, ~/.minimax, ~/.mmx, ~/.qoder, ~/.mimocode); a profile gives them
// their own home. Verified: an empty home reports logged out for each.
export const homeProfileAdapters = new Set(['zcode', 'qwen', 'kimi', 'mcode', 'mmx', 'qoder', 'mimo', 'agy']);
export const accountProfileAdapters = new Set([...profileAdapters, ...homeProfileAdapters]);

export function profileDirectory(route, directory) {
  return path.join(directory, 'profiles', route.adapter, route.profile);
}

export function profileEnvironment(route, directory, create = true) {
  if (!route.profile || route.api || route.runtime === 'wsl' || !(profileAdapters.has(route.adapter) || homeProfileAdapters.has(route.adapter))) return {};
  const target = profileDirectory(route, directory);
  if (create) mkdirSync(target, { recursive: true, mode: 0o700 });
  if (route.adapter === 'agy') return { USERPROFILE: target, HOME: target, WSL_DISTRO_NAME: 'cli-agent-pool' };
  if (homeProfileAdapters.has(route.adapter)) return { USERPROFILE: target, HOME: target };
  return route.adapter === 'codex' ? { CODEX_HOME: target } : { CLAUDE_CONFIG_DIR: target };
}

// The home whose CLI files belong to this route (profile home or the real home).
export function profileHome(route, directory, home = homedir()) {
  return route.profile && !route.api && route.runtime !== 'wsl' && homeProfileAdapters.has(route.adapter) ? profileDirectory(route, directory) : home;
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

// WSL has no xdg-open, so agy cannot open its sign-in page. The login window puts
// this Pool-owned helper first on PATH; it opens only https URLs in the Windows browser.
export const wslHelperDirectory = route => `${route.wsl.home}/.cli-agent-pool/bin`;
export const wslLoginPath = route => `${wslHelperDirectory(route)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
export const wslBrowserHelper = '#!/bin/sh\n# CLI Agent Pool: open an https sign-in URL in the Windows default browser.\ncase "$1" in\n  https://*) exec /mnt/c/Windows/System32/rundll32.exe url.dll,FileProtocolHandler "$1" ;;\nesac\nexit 1\n';

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

const expandProfileHomeGrants = (items, sourceHome, targetHome) => {
  if (!Array.isArray(items) || !sourceHome || !targetHome) return Array.isArray(items) ? items : [];
  const srcFwd = sourceHome.replace(/\\/g, '/').replace(/\/+$/, '');
  const tgtFwd = targetHome.replace(/\\/g, '/').replace(/\/+$/, '');
  const out = [...items];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const norm = item.replace(/\\/g, '/');
    if (norm.includes(srcFwd)) out.push(norm.split(srcFwd).join(tgtFwd));
  }
  return [...new Set(out)];
};

// Mirror the owner's native Antigravity project permissions and trusted folders
// into a WSL or native profile. Owner actions call this (login, catalog refresh,
// service start); task submission never does.
// Credentials and conversations are not part of these files.
export function mirrorAgyPermissions(targetGeminiDir, sourceHome = homedir(), isWsl = true) {
  const isWslProfile = Boolean(isWsl);
  const targetHome = path.dirname(targetGeminiDir);
  const targetHomeFwd = targetHome.replace(/\\/g, '/').replace(/\/+$/, '');
  const sourceGemini = path.join(sourceHome, '.gemini');
  let projects = 0;
  const sourceProjects = path.join(sourceGemini, 'config', 'projects');
  let files = [];
  try { files = readdirSync(sourceProjects).filter(file => /^[A-Za-z0-9_.-]{1,120}\.json$/.test(file)); } catch { /* no native projects */ }
  for (const file of files) {
    const project = readJson(path.join(sourceProjects, file));
    const resources = project?.projectResources?.resources;
    if (!project || typeof project.id !== 'string' || !Array.isArray(resources)) continue;
    let mapped;
    if (isWslProfile) {
      mapped = resources.flatMap(resource => {
        const linuxPath = windowsUriToWsl(resource?.gitFolder?.folderUri ?? resource?.folderUri);
        if (!linuxPath) return [];
        const folderUri = encodeWslUri(linuxPath);
        return [resource.gitFolder ? { ...resource, gitFolder: { ...resource.gitFolder, folderUri } } : { ...resource, folderUri }];
      });
    } else {
      mapped = resources;
    }
    if (!mapped.length) continue;
    const mirroredProject = { ...project, projectResources: { ...project.projectResources, resources: mapped } };
    if (!isWslProfile && Array.isArray(project.permissionGrants?.allow)) {
      const expanded = expandProfileHomeGrants(project.permissionGrants.allow, sourceHome, targetHome);
      if (expanded.length) expanded.push(`read_file(${targetHomeFwd}/.project-brain/*)`, `read_file(${targetHomeFwd}/.project-brain/**)`, `write_file(${targetHomeFwd}/.project-brain/*)`, `write_file(${targetHomeFwd}/.project-brain/**)`);
      mirroredProject.permissionGrants = { ...project.permissionGrants, allow: [...new Set(expanded)] };
    }
    writeJsonAtomic(path.join(targetGeminiDir, 'config', 'projects', file), mirroredProject);
    projects++;
  }
  const source = readJson(path.join(sourceGemini, 'antigravity-cli', 'settings.json')) || {};
  const targetFile = path.join(targetGeminiDir, 'antigravity-cli', 'settings.json');
  const target = readJson(targetFile) || {};
  const union = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...b])];
  const rawAllow = (source.permissions?.allow || []).filter(item => typeof item === 'string');
  const allow = rawAllow.map(grant => isWslProfile ? mapGrant(grant) : grant).filter(Boolean);
  const effectiveAllow = isWslProfile ? allow : expandProfileHomeGrants(allow, sourceHome, targetHome);
  const deny = (source.permissions?.deny || []).filter(item => typeof item === 'string').map(grant => isWslProfile ? mapGrant(grant) : grant).filter(Boolean);
  const trusted = (source.trustedWorkspaces || []).map(item => isWslProfile ? windowsToWsl(item) : item).filter(Boolean);
  const next = { ...target, permissions: { ...(target.permissions || {}), allow: union(target.permissions?.allow, effectiveAllow), ...(deny.length || target.permissions?.deny ? { deny: union(target.permissions?.deny, deny) } : {}) }, trustedWorkspaces: union(target.trustedWorkspaces, trusted) };
  if (JSON.stringify(next) !== JSON.stringify(target) || !existsSync(targetFile)) writeJsonAtomic(targetFile, next);
  if (!isWslProfile) {
    const trustedFoldersSource = path.join(sourceGemini, 'trustedFolders.json');
    const trustedFoldersTarget = path.join(targetGeminiDir, 'trustedFolders.json');
    if (existsSync(trustedFoldersSource)) {
      try {
        const mergedTrusted = { ...(readJson(trustedFoldersTarget) || {}), ...(readJson(trustedFoldersSource) || {}) };
        writeJsonAtomic(trustedFoldersTarget, mergedTrusted);
      } catch {}
    }
    const configSource = path.join(sourceGemini, 'config', 'config.json');
    const configTarget = path.join(targetGeminiDir, 'config', 'config.json');
    if (existsSync(configSource)) {
      try {
        const srcCfg = readJson(configSource) || {};
        const tgtCfg = readJson(configTarget) || {};
        writeJsonAtomic(configTarget, { ...tgtCfg, ...srcCfg, userSettings: { ...(tgtCfg.userSettings || {}), ...(srcCfg.userSettings || {}) } });
      } catch {}
    }
    const mcpSource = path.join(sourceGemini, 'config', 'mcp_config.json');
    const mcpTarget = path.join(targetGeminiDir, 'config', 'mcp_config.json');
    if (existsSync(mcpSource)) {
      try {
        const srcMcp = readJson(mcpSource) || {};
        const tgtMcp = readJson(mcpTarget) || {};
        writeJsonAtomic(mcpTarget, { ...tgtMcp, ...srcMcp, mcpServers: { ...(tgtMcp.mcpServers || {}), ...(srcMcp.mcpServers || {}) } });
      } catch {}
    }
    const migratedSource = path.join(sourceGemini, 'config', '.migrated');
    const migratedTarget = path.join(targetGeminiDir, 'config', '.migrated');
    if (existsSync(migratedSource) && !existsSync(migratedTarget)) {
      try { mkdirSync(path.dirname(migratedTarget), { recursive: true }); writeFileSync(migratedTarget, ''); } catch {}
    }
  }
  return { projects, grants: allow.length, trusted: trusted.length };
}
