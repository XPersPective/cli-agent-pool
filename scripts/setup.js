import { existsSync, mkdtempSync, realpathSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory, PoolError } from '../src/config.js';
import { runProcess } from '../src/process.js';
import { installDesktopAndSkills } from '../src/daemon.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export function npmEntry(env = process.env) {
  const candidates = [env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  const entry = candidates.find(candidate => candidate && path.isAbsolute(candidate) && path.basename(candidate) === 'npm-cli.js' && existsSync(candidate));
  if (!entry) throw new PoolError('NPM_REQUIRED', 'Node.js npm-cli.js bulunamadı. Kurulumu npm run setup ile başlatın.');
  return entry;
}

export async function setup({ run = spec => runProcess(spec).done, install = installDesktopAndSkills, directory = dataDirectory(), npm = npmEntry() } = {}) {
  const releaseDirectory = mkdtempSync(path.join(tmpdir(), 'cli-agent-pool-setup-'));
  let tarball;
  const invoke = args => run({ argv: [process.execPath, npm, ...args], cwd: root, timeoutMs: 120_000 });
  try {
    const pack = await invoke(['pack', '--quiet', '--pack-destination', releaseDirectory]);
    if (pack.code !== 0 || pack.stopReason) throw new PoolError('PACKAGE_BUILD_FAILED', 'Paket oluşturulamadı; Windows kurulumu uygulanmadı.');
    const filename = pack.output.trim();
    if (!/^cli-agent-pool-[a-zA-Z0-9.-]+\.tgz$/.test(filename)) throw new PoolError('PACKAGE_BUILD_FAILED', 'Paket adı doğrulanamadı.');
    tarball = path.join(releaseDirectory, filename);
    const installed = await invoke(['install', '-g', tarball, '--ignore-scripts', '--no-audit', '--no-fund']);
    if (installed.code !== 0 || installed.stopReason) throw new PoolError('PACKAGE_INSTALL_FAILED', 'Global npm kurulumu tamamlanmadı; kısayol/skill kurulumu başlatılmadı.');
    return await install(directory);
  } finally {
    if (tarball && existsSync(tarball)) rmSync(tarball);
    // Remove only this unique empty temporary directory; never recursively delete a workspace.
    try { rmdirSync(releaseDirectory); } catch { /* Preserve unexpected files for inspection. */ }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
