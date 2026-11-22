import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? files(filename) : filename.endsWith('.js') ? [filename] : [];
  });
}
for (const filename of ['src', 'bin', 'scripts', 'test', 'web', 'remote'].flatMap(files)) {
  const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const pyFiles = ['src/supervisor.py', 'src/wincred.py'];
const pyBin = process.platform === 'win32' ? 'python' : 'python3';
const pyCheck = spawnSync(pyBin, ['-B', '-c', "import ast, sys; [ast.parse(open(f, encoding='utf-8').read(), filename=f) for f in sys.argv[1:]]", ...pyFiles], { stdio: 'inherit' });
if (pyCheck.error?.code !== 'ENOENT' && pyCheck.status !== 0) process.exit(pyCheck.status || 1);
console.log('JavaScript and Python syntax checks passed.');
