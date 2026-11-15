import test from 'node:test';
import assert from 'node:assert/strict';
import { importDiscoveredRoutes } from '../src/adapters.js';

test('tarama kurulu CLI’lar için yeni bağlantı kurmaz; silinen abonelik geri gelmez', () => {
  // Kullanıcı yalnızca codex bağlantısını tutuyor; diğer kurulu CLI'lar (kimi, hermes, ...) yok.
  const config = {
    routes: [{ id: 'codex-local', adapter: 'codex', enabled: true, billing: 'subscription', models: [] }],
  };

  const result = importDiscoveredRoutes(config);

  assert.equal(result.addedRoutes, 0);
  assert.equal(result.config.routes.length, 1);
  assert.equal(result.config.routes[0].id, 'codex-local');
});

test('tarama var olan bağlantının modellerini tazeler ama bağlantı listesini değiştirmez', () => {
  const config = {
    routes: [{
      id: 'kimi-local',
      adapter: 'kimi',
      enabled: false,
      billing: 'token_plan',
      models: [{ id: 'kimi-code/k3-256k', alias: 'Kimi K3 256k', group: 'kimi', enabled: true, efforts: [], kinds: ['text', 'read'] }],
    }],
  };

  const result = importDiscoveredRoutes(config);

  assert.equal(result.addedRoutes, 0);
  assert.equal(result.config.routes.length, 1);
  assert.equal(result.config.routes[0].id, 'kimi-local');
  assert.equal(result.config.routes[0].enabled, false);
});
