import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateNeedsRestart } from '../src/daemon.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('kurulu sürüm çalışan sürümden farklıysa servis yeniden başlatılır', () => {
  assert.equal(updateNeedsRestart('2.9.0', '2.9.0'), false);
  assert.equal(updateNeedsRestart('2.8.0', '2.9.0'), true);
  assert.equal(updateNeedsRestart('2.9.0', ''), false);
  assert.equal(updateNeedsRestart('', '2.9.0'), true);
});

test('CLI yeniden başlatma komutunu sunar', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'bin', 'pool.js'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /restart\s+Stop the background service/);
});

test('paneldeki uzun toplu işlem açıklamaları kaldırıldı', () => {
  const app = readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
  const html = readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  const removed = [
    'toplu işlem için işaretleyin',
    'toplu havuza ekleme / devre dışı bırakma / gizleme için seçin',
    'Kataloğa ve havuzlara hiç girmesini istemediğiniz modelleri işaretleyebilirsiniz.',
    'tek tek ya da topluca silebilirsiniz.',
  ];
  for (const text of removed) {
    assert.equal(app.includes(text), false, `app.js: ${text}`);
    assert.equal(html.includes(text), false, `index.html: ${text}`);
  }
});

test('hiyerarşi satırları aynı hizada ve aynı görünümde', () => {
  const app = readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
  const css = readFileSync(path.join(root, 'web', 'style.css'), 'utf8');
  assert.match(app, /makeHierarchyLevel/);
  assert.match(app, /'Araçlar'/);
  assert.match(app, /'Abonelikler'/);
  assert.match(app, /'Model aileleri'/);
  // Ağaç/ray göstergesi kalmadı: her satır aynı hizada.
  assert.equal(/hierarchy-path/.test(app), false);
  assert.equal(/hierarchy-crumb/.test(app), false);
  assert.equal(/\.hierarchy-level\.level-subscription/.test(css), false);
  assert.equal(/\.hierarchy-level\.level-family/.test(css), false);
  assert.match(css, /\.hierarchy-level \.hierarchy-pills button/);
});

test('ayarlarda bağlantı açma anahtarı anında kaydedilir', () => {
  const app = readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
  const css = readFileSync(path.join(root, 'web', 'style.css'), 'utf8');
  assert.match(app, /makeSwitch/);
  assert.match(app, /role', 'switch'/);
  assert.match(app, /onLabel = 'Etkin', offLabel = 'Kapalı'/);
  // Anahtar değişimi kaydeder (yalnız taslakta bırakılmaz) ve diğer taslakları bozmadan izole kaydeder.
  assert.match(app, /(?:route|targetBase)\.enabled = value;[\s\S]{0,400}call\('save',/);
  assert.match(css, /\.switch-track/);
  assert.match(css, /\.switch-state/);
});
