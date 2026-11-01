import { createHash } from 'node:crypto';
import { mkdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PoolError } from './config.js';

export function zcodePlanConfig(selection) {
  if (!/^account:(zai|bigmodel)-(individual-coding-plan|start-plan)$/.test(selection?.providerId || '') ||
      typeof selection?.modelId !== 'string' || !selection.modelId || selection.modelId.length > 100) {
    throw new PoolError('BILLING_UNCONFIRMED', 'ZCode plan rotasında native Individual veya Starter hesabı seçilmeli. Kişisel API provider varsayılanına yönlendirme yapılmadı.');
  }
  return { schemaVersion: 1, config: {
    providerOrder: [selection.providerId],
    providerConfigRules: { providerRules: [] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    defaultModelSelection: { providerId: selection.providerId, modelId: selection.modelId },
  } };
}

// Existing native credentials stay in their official store. A present personal
// file also prevents the CLI from importing unrelated legacy API providers.
export function zcodePlanFile(directory, selection) {
  const content = JSON.stringify(zcodePlanConfig(selection));
  const root = path.join(directory, 'native-zcode');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink()) throw new PoolError('UNSAFE_DATA_DIRECTORY', 'Native ayar klasörü bağlantı olamaz.');
  const file = path.join(root, createHash('sha256').update(content).digest('hex') + '.json');
  try { writeFileSync(file, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (lstatSync(file).isSymbolicLink() || readFileSync(file, 'utf8') !== content) throw new PoolError('UNSAFE_DATA_DIRECTORY', 'Native plan ayarı değişmiş; dosya üzerine yazılmadı.');
  return file;
}
