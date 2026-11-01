import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agyProjectArguments } from '../src/agy-project.js';

test('Antigravity selects the closest native project and preserves its permission policy', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'pool-agy-project-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const directory = path.join(home, '.gemini/config/projects');
  const workspace = path.join(home, 'repo');
  const nested = path.join(workspace, 'nested');
  mkdirSync(directory, { recursive: true });
  mkdirSync(nested, { recursive: true });
  mkdirSync(`${workspace}-other`);
  const add = (id, root, git = false) => {
    const resource = { folderUri: pathToFileURL(root).href };
    const file = path.join(directory, `${id}.json`);
    writeFileSync(file, JSON.stringify({ id, permissionGrants: { permissionGrants: { deny: ['command(*)'] } }, projectResources: { resources: [git ? { gitFolder: resource } : resource] } }));
    return file;
  };
  const file = add('parent', workspace, true);
  const original = readFileSync(file, 'utf8');
  assert.deepEqual(agyProjectArguments(workspace, home), ['--project', 'parent']);
  assert.deepEqual(agyProjectArguments(nested, home), ['--project', 'parent']);
  assert.deepEqual(agyProjectArguments(`${workspace}-other`, home), []);
  add('child', nested);
  assert.deepEqual(agyProjectArguments(nested, home), ['--project', 'child']);
  assert.equal(readFileSync(file, 'utf8'), original);
  writeFileSync(path.join(directory, 'broken.json'), '{');
  writeFileSync(path.join(directory, 'stale.json'), JSON.stringify({ id: 'stale', projectResources: { resources: [{ folderUri: 'https://example.com' }] } }));
  assert.deepEqual(agyProjectArguments(nested, home), ['--project', 'child']);
  add('duplicate', nested);
  assert.deepEqual(agyProjectArguments(nested, home), []);
  assert.deepEqual(agyProjectArguments(path.join(home, 'missing'), home), []);
});
