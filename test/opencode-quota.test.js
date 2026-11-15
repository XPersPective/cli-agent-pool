import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { opencodeAuthKeys, parseOpenCodeGoUsage, parseOpenCodeStats, opencodeStatsNote } from '../src/quotas.js';
import { modelIssueInfo, quotaToggleState, quotaToggleTarget } from '../web/pool-state.js';

const root = fileURLToPath(new URL('..', import.meta.url));

const statsSample = `
┌────────────────────────────┐
│          OVERVIEW          │
├────────────────────────────┤
│Sessions                    9 │
│Messages                   22 │
│Days                        1 │
└────────────────────────────┘
┌────────────────────────────┐
│      COST & TOKENS         │
├────────────────────────────┤
│Total Cost               $0.06 │
│Avg Cost/Day             $0.02 │
└────────────────────────────┘
`;

test('opencode auth store: yalnız api türündeki anahtarlar okunur', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'pool-oc-'));
  const dir = path.join(base, 'opencode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    opencode: { type: 'api', key: 'sk-zen' },
    'opencode-go': { type: 'api', key: 'sk-go' },
    'opencode-extra': { type: 'oauth', key: 'not-an-api-key' },
  }));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = base;
  try {
    const keys = opencodeAuthKeys(base);
    assert.equal(keys.opencode, 'sk-zen');
    assert.equal(keys['opencode-go'], 'sk-go');
    assert.equal(keys['opencode-extra'], undefined);
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
});

test('opencode.json içindeki sağlayıcı anahtarları da okunur', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'pool-oc-cfg-'));
  const dataDir = path.join(base, 'data', 'opencode');
  const configDir = path.join(base, 'config', 'opencode');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ opencode: { type: 'api', key: 'sk-zen' } }));
  writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({
    provider: {
      openrouter: { options: { apiKey: 'sk-openrouter' } },
      respan: { options: { apiKey: '{env:POOL_TEST_SPAN_KEY}' } },
      nim: { options: { apiKey: '{file:./key.txt}' } },
    },
  }));
  const previousData = process.env.XDG_DATA_HOME;
  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousEnv = process.env.POOL_TEST_SPAN_KEY;
  process.env.XDG_DATA_HOME = path.join(base, 'data');
  process.env.XDG_CONFIG_HOME = path.join(base, 'config');
  process.env.POOL_TEST_SPAN_KEY = 'sk-respan';
  try {
    const keys = opencodeAuthKeys(base);
    assert.equal(keys.opencode, 'sk-zen');
    assert.equal(keys.openrouter, 'sk-openrouter');
    assert.equal(keys.respan, 'sk-respan');
    assert.equal(keys.nim, undefined);
  } finally {
    if (previousData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previousData;
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousConfig;
    if (previousEnv === undefined) delete process.env.POOL_TEST_SPAN_KEY; else process.env.POOL_TEST_SPAN_KEY = previousEnv;
  }
});

test('go kullanımı: farklı pencere yazımları yüzdeye çevrilir', () => {
  const windows = parseOpenCodeGoUsage({ windows: [{ name: '5h', remaining: 80, resets_at: '2026-11-15T12:00:00Z' }, { name: 'weekly', limit: 100, used: 25 }] });
  assert.equal(windows.length, 2);
  const five = windows.find(window => window.name === 'five_hour');
  assert.equal(five.remainingPercent, 80);
  assert.equal(five.windowMinutes, 300);
  assert.equal(five.resetsAt, '2026-11-15T12:00:00.000Z');
  const weekly = windows.find(window => window.name === 'seven_day');
  assert.equal(weekly.remainingPercent, 75);
  assert.equal(weekly.windowMinutes, 10_080);
});

test('go kullanımı: bilinmeyen gövde sessizce boş döner', () => {
  assert.deepEqual(parseOpenCodeGoUsage(null), []);
  assert.deepEqual(parseOpenCodeGoUsage({ hello: 'world' }), []);
});

test('istatistik çıktısı günlük oturum/mesaj/maliyet olarak okunur', () => {
  const stats = parseOpenCodeStats(statsSample);
  assert.equal(stats.sessions, 9);
  assert.equal(stats.messages, 22);
  assert.equal(stats.costUsd, 0.06);
  assert.match(opencodeStatsNote(stats), /9 oturum/);
  assert.match(opencodeStatsNote(stats), /\$0\.06/);
  assert.match(opencodeStatsNote(stats), /^Bugün:/);
  assert.equal(parseOpenCodeStats('nothing here'), null);
});

test('hesap düzeyi bilgi veren sağlayıcı uyarı rozeti göstermez', () => {
  const route = { id: 'opencode-local', adapter: 'opencode', billing: 'free', enabled: true };
  const model = { id: 'opencode/minimax-m3.1-flash-free', enabled: true };
  const known = modelIssueInfo(route, model, { status: 'available', windows: [], informational: true, note: 'Yerel kullanım (son 1 gün): 9 oturum' });
  assert.equal(known.isUnknown, false);
  assert.equal(known.badge, 'Hazır');
  const unknown = modelIssueInfo(route, model, { status: 'unknown', windows: [] });
  assert.equal(unknown.isUnknown, true);
  assert.equal(unknown.badge, 'Kota okunamıyor');
  const plain = modelIssueInfo(route, model, { status: 'available', windows: [] });
  assert.equal(plain.isUnknown, true);
});

test('panel: yüzde penceresi yoksa açılır ok satırı kurulmaz', () => {
  const app = readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
  assert.match(app, /function quotaFlatText\(/);
  assert.match(app, /element\('small', text, 'quota-flat'\)/);
  assert.doesNotMatch(app, /'Bilinmiyor'/);
});

test('kota düğmesi sayfadaki gerçek durumu gösterir', () => {
  const closed = quotaToggleState([{ open: false }]);
  assert.equal(closed.label, 'Kotaları göster');
  assert.equal(closed.pressed, false);
  assert.equal(closed.disabled, false);
  const open = quotaToggleState([{ open: true }, { open: true }]);
  assert.equal(open.label, 'Kotaları gizle');
  assert.equal(open.pressed, true);
  const empty = quotaToggleState([]);
  assert.equal(empty.disabled, true);
  assert.equal(empty.label, 'Kota ayrıntısı yok');
  assert.equal(quotaToggleTarget([{ open: true }, { open: false }]), true);
  assert.equal(quotaToggleTarget([{ open: true }]), false);
});

test('kapalı kota durumunda tüm kota blokları gizlenir', () => {
  const app = readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
  const css = readFileSync(path.join(root, 'web', 'style.css'), 'utf8');
  assert.match(app, /classList\.toggle\('quota-collapsed', !quotasOpen\)/);
  assert.match(css, /\.quota-collapsed \.quota-cell \{ display: none; \}/);
});
