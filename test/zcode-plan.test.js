import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zcodePlanConfig, zcodePlanFile } from '../src/zcode-plan.js';

test('ZCode plan projection contains no personal API providers and stays immutable across concurrent model selections', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-zcode-plan-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const individual = { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3-Flash' };
  const starter = { ...individual, providerId: 'account:zai-start-plan' };
  const a = zcodePlanFile(root, individual), b = zcodePlanFile(root, starter);
  assert.notEqual(a, b);
  assert.equal(zcodePlanFile(root, individual), a);
  assert.deepEqual(JSON.parse(readFileSync(a)), zcodePlanConfig(individual));
  assert.deepEqual(JSON.parse(readFileSync(b)).config.providerConfigRules.providerRules, []);
  assert(!readFileSync(a, 'utf8').includes('apiKey'));
  assert.throws(() => zcodePlanFile(root, { providerId: 'personal-api', modelId: 'model' }), { code: 'BILLING_UNCONFIRMED' });
  writeFileSync(a, '{}');
  assert.throws(() => zcodePlanFile(root, individual), { code: 'UNSAFE_DATA_DIRECTORY' });
  assert.equal(readFileSync(a, 'utf8'), '{}');
});
