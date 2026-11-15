import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settingsViewSignature } from '../web/pool-state.js';

const root = fileURLToPath(new URL('..', import.meta.url));

const config = () => ({
  revision: 7,
  categories: [{ id: 'coding', name: 'Kodlama' }],
  routes: [
    {
      id: 'codex-local',
      adapter: 'codex',
      enabled: true,
      billing: 'subscription',
      profile: '',
      models: [
        { id: 'gpt-5', enabled: true, memberships: [{ group: 'coding' }] },
        { id: 'gpt-5-codex', enabled: false, memberships: [] },
      ],
    },
  ],
});

test('aynı veri aynı imzayı üretir: liste gereksiz yere yeniden kurulmaz', () => {
  const a = settingsViewSignature(config(), { 'codex-local': { status: 'available', remaining: 80 } }, 'tool|route|search|filter');
  const b = settingsViewSignature(config(), { 'codex-local': { status: 'available', remaining: 80 } }, 'tool|route|search|filter');
  assert.equal(a, b);
});

test('bağlantı, model, kota veya arama değişince imza değişir', () => {
  const base = settingsViewSignature(config(), { 'codex-local': { status: 'available', remaining: 80 } }, 'ui');
  const toggled = config();
  toggled.routes[0].enabled = false;
  assert.notEqual(base, settingsViewSignature(toggled, { 'codex-local': { status: 'available', remaining: 80 } }, 'ui'));

  const filtered = config();
  filtered.routes[0].models[0].memberships = [];
  assert.notEqual(base, settingsViewSignature(filtered, { 'codex-local': { status: 'available', remaining: 80 } }, 'ui'));

  assert.notEqual(base, settingsViewSignature(config(), { 'codex-local': { status: 'available', remaining: 10 } }, 'ui'));
  assert.notEqual(base, settingsViewSignature(config(), { 'codex-local': { status: 'available', remaining: 80 } }, 'başka-ui'));
});

test('kota önbelleği revizyonu değiştirse de imza sabit kalır', () => {
  const a = settingsViewSignature(config(), { 'codex-local': { status: 'available', remaining: 80 } }, 'ui');
  const b = settingsViewSignature({ ...config(), revision: 99 }, { 'codex-local': { status: 'available', remaining: 80 } }, 'ui');
  assert.equal(a, b);
});

test('panel yeniden kurulurken kaydırma konumu ve odak korunur', () => {
  const app = readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
  assert.match(app, /function withStableView\(/);
  assert.match(app, /window\.scrollTo\(\{ top: scrollY \}\)/);
  assert.match(app, /preventScroll: true/);
  assert.match(app, /function renderSettings\(force = false\)/);
  assert.match(app, /signature === settingsRenderSignature/);
  assert.match(app, /withStableView\(\(\) => renderSettingsBody\(\)\)/);
  assert.match(app, /withStableView\(\(\) => renderPoolBody\(\)\)/);
  assert.match(app, /withStableView\(\(\) => renderCatalogBody\(\)\)/);
  assert.match(app, /openDetails\.has\(key\)/);
});
