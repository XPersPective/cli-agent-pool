import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PoolError } from './config.js';

const supervisor = fileURLToPath(new URL('./supervisor.py', import.meta.url));
const environmentNames = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'LANG', 'LC_ALL', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PYTHONIOENCODING']);

export function childEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => environmentNames.has(key.toUpperCase())));
  return { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
}

export function runProcess({ argv, cwd, input = '', relay = false, python = process.platform === 'win32' ? 'python' : 'python3', timeoutMs = 30_000, onLine = () => {}, maxBytes = 1_048_576 }) {
  let stopReason = null;
  let bytes = 0;
  let output = '';
  let stderr = '';
  let settled = false;
  let lineFailure = false;
  const child = spawn(python, ['-u', supervisor], { cwd, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const cancel = reason => {
    if (settled || stopReason) return;
    stopReason = reason || 'CANCELLED';
    child.stdin.end();
  };
  const timer = setTimeout(() => cancel('TIMEOUT'), timeoutMs);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => { try { onLine(line); } catch { lineFailure = true; cancel('PROTOCOL_ERROR'); } });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) cancel('OUTPUT_LIMIT');
    else output += chunk;
  });
  child.stderr.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) cancel('OUTPUT_LIMIT');
    else stderr += chunk;
  });
  child.stdin.on('error', () => {});
  const done = new Promise(resolve => {
    child.once('error', () => { stopReason ||= 'SPAWN_FAILED'; });
    child.once('close', code => {
      settled = true;
      clearTimeout(timer);
      lines.close();
      resolve({ code, output, stderr, stopReason: stopReason || (lineFailure ? 'PROTOCOL_ERROR' : null) });
    });
  });
  child.stdin.write(JSON.stringify({ argv, cwd, input, relay }) + '\n');
  return { done, cancel, send: input => child.stdin.write(JSON.stringify({ input }) + '\n') };
}

export async function capture(argv, cwd, python) {
  const result = await runProcess({ argv, cwd, python, timeoutMs: 15_000 }).done;
  if (result.stopReason) throw new PoolError(result.stopReason, 'CLI kontrolü tamamlanamadı. Kurulumu ve Python erişimini kontrol edin.');
  return result;
}
