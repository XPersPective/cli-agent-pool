import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDiscoveredModels } from '../src/adapters.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('tarama yeni model ekler ve mevcut modelin gösterilen adını tazeler', () => {
  const route = {
    id: 'zcode-local',
    adapter: 'zcode',
    models: [
      { id: 'zcode-default', alias: 'ZCode varsayılan modeli: GLM-4.6 (account:zai)', group: 'zai-plan', enabled: true, efforts: [], kinds: ['text', 'read', 'write'], memberships: [{ group: 'pool' }] },
    ],
  };

  const result = applyDiscoveredModels(route, [
    { id: 'zcode-default', alias: 'ZCode varsayılan modeli: GLM-5.3 (account:zai-individual-coding-plan)', group: 'zai-plan', efforts: [], kinds: ['text', 'read', 'write'] },
    { id: 'glm-5.3-flash', alias: 'GLM-5.3-Flash', group: 'zai-plan', efforts: ['low', 'high'], kinds: ['text'] },
  ], 'zcode');

  assert.equal(result.added, 1);
  assert.equal(result.refreshed, 1);
  assert.equal(route.models.length, 2);
  // Yeni ZCode varsayılanı görünür oldu.
  assert.match(route.models[0].alias, /GLM-5\.3/);
  // Kullanıcı alanları korundu.
  assert.deepEqual(route.models[0].memberships, [{ group: 'pool' }]);
  assert.equal(route.models[0].enabled, true);
  assert.equal(route.models[1].id, 'glm-5.3-flash');
  assert.deepEqual(route.models[1].efforts, ['low', 'high']);
});

test('ayarlarda yinelenen kurulu CLI özeti kaldırıldı, bağlantılar tek yerden yönetiliyor', () => {
  const html = readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  const app = readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

  assert.equal(html.includes('Bilgisayarda bulunamadı'), false);
  assert.equal(html.includes('id="providers"'), false);
  assert.equal(html.includes('Keşif, hesaplar, güncelleme ve kullanım özeti'), false);
  assert.equal(app.includes('Bilgisayarda bulunamadı'), false);
  // Bağlantı yönetimi ve tarama düğmeleri kaldı.
  assert.match(html, /Bağlantı ve hesap ayarları/);
  assert.match(html, /id="scan-import"/);
  assert.match(html, /id="refresh-quotas"/);
  assert.match(html, /id="sync-all-permissions"/);
  assert.match(html, /id="routes-filter"/);
});

test('panelde API rehberi bulunur ve yerel adresle doldurulur', () => {
  const html = readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  const app = readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

  assert.match(html, /API rehberi/);
  assert.match(html, /data-origin/);
  assert.match(html, /\/api\/quotas/);
  assert.match(html, /\/api\/pools/);
  assert.match(html, /\/api\/tasks/);
  assert.match(html, /cli-agent-pool status/);
  assert.match(app, /fillOriginPlaceholders/);
});

test('model kartı yetenek açıklaması uzun metin yerine kompakt rozet kullanır', () => {
  const capabilities = readFileSync(path.join(root, 'web', 'capabilities.js'), 'utf8');
  assert.equal(capabilities.includes('İstek kapsamı ve CLI izinleri geçerli'), false);
  assert.match(capabilities, /okuma \/ yazma/);
});
