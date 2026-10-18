import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? files(filename) : filename.endsWith('.js') ? [filename] : [];
  });
}
for (const filename of ['src', 'bin', 'scripts', 'test', 'web'].flatMap(files)) {
  const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('JavaScript syntax checks passed.');
