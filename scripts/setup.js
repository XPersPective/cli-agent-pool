import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from '../src/config.js';
import { capture } from '../src/process.js';
import { installDesktopAndSkills } from '../src/daemon.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function setup() {
  let tarball = null;
  try {
    const pack = await capture([npmCmd, 'pack', '--quiet'], root);
    if (pack.code === 0 && pack.output.trim()) {
      const filename = pack.output.trim().split(/\r?\n/).pop().trim();
      tarball = path.join(root, filename);
      await capture([npmCmd, 'install', '-g', tarball, '--ignore-scripts', '--no-audit', '--no-fund'], root);
    }
  } finally {
    if (tarball) {
      try { rmSync(tarball, { force: true }); } catch { /* ignore */ }
    }
  }
  const result = await installDesktopAndSkills(dataDirectory());
  console.log(JSON.stringify(result, null, 2));
}

setup().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
