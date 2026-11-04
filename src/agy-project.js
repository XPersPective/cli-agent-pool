import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse the owner's native project policy. Never create projects or grant trust
// as a side effect of an agent submitting a task.
// `resolveUri` maps a native folder URI to a local path; WSL profiles store /mnt URIs.
export function agyProjectArguments(workspace, home = homedir(), resolveUri = fileURLToPath) {
  let target, files;
  const directory = path.join(home, '.gemini', 'config', 'projects');
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
        const local = resolveUri(uri);
        if (!local) continue;
        const root = realpathSync(local);
        const relative = path.relative(root, target);
        if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
          matches.push({ id: project.id, root });
        }
      }
    } catch { /* Unavailable/stale native projects do not change task admission. */ }
  }
  matches.sort((a, b) => b.root.length - a.root.length || a.id.localeCompare(b.id));
  // Conflicting policies for the same root require native selection, not a guess.
  const best = matches[0];
  if (!best || matches.some(item => item.root === best.root && item.id !== best.id)) return [];
  return ['--project', best.id];
}
