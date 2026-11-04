import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PoolError } from './config.js';

export const agyProjectDirectory = (home = homedir()) => path.join(home, '.gemini', 'config', 'projects');

// Native project files whose folder resources contain the workspace, deepest root first.
export function agyProjectMatches(workspace, home = homedir(), resolveUri = fileURLToPath) {
  let target, files;
  const directory = agyProjectDirectory(home);
  try { target = realpathSync(workspace); files = readdirSync(directory).sort(); }
  catch { return []; }
  const matches = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const project = JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
      if (typeof project.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(project.id)) continue;
      const resources = project.projectResources?.resources;
      if (!Array.isArray(resources)) continue;
      for (const resource of resources) {
        const uri = resource?.gitFolder?.folderUri ?? resource?.folderUri;
        if (typeof uri !== 'string') continue;
        let root;
        try { const local = resolveUri(uri); if (!local) continue; root = realpathSync(local); }
        catch { continue; /* A stale resource does not hide the project's other folders. */ }
        const relative = path.relative(root, target);
        if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
          matches.push({ id: project.id, root, file: path.join(directory, file) });
        }
      }
    } catch { /* Unreadable/malformed native projects do not change task admission. */ }
  }
  return matches.sort((a, b) => b.root.length - a.root.length || a.id.localeCompare(b.id));
}

// Reuse the owner's native project policy. Never create projects or grant trust
// as a side effect of an agent submitting a task.
// `resolveUri` maps a native folder URI to a local path; WSL profiles store /mnt URIs.
export function agyProjectArguments(workspace, home = homedir(), resolveUri = fileURLToPath) {
  const matches = agyProjectMatches(workspace, home, resolveUri);
  const best = matches[0];
  if (!best) return [];
  const same = root => process.platform === 'win32' ? root.toLowerCase() === best.root.toLowerCase() : root === best.root;
  // Two projects for the same root have two permission policies. Running with
  // no --project would silently fall back to a grant-less default project.
  const rivals = [...new Map(matches.filter(item => same(item.root)).map(item => [item.id, item])).values()];
  if (rivals.length > 1) throw new PoolError('PROJECT_AMBIGUOUS',
    `Antigravity has ${rivals.length} native projects for ${best.root}: ${rivals.map(item => item.file).join(', ')}. Keep one: remove this folder from the other project file (or delete the stale project in Antigravity), then retry. Pool does not pick a permission policy for you.`);
  return ['--project', best.id];
}
