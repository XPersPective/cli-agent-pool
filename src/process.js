import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PoolError } from './config.js';

const supervisor = fileURLToPath(new URL('./supervisor.py', import.meta.url));
const environmentNames = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'OS', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'PSMODULEPATH', 'USERDOMAIN', 'USERNAME',
  'LANG', 'LC_ALL', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PYTHONIOENCODING',
]);

const pythonCache = new Map();

function isRealFile(candidate) {
  try {
    if (!existsSync(candidate)) return false;
    const st = statSync(candidate);
    // WindowsApps store shims are 0-byte reparse points that fail or pop windows.
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

export function resolveWindowsPython(python = 'python', { platform = process.platform, envPath = process.env.PATH || '', preferWindowless = true } = {}) {
  if (platform !== 'win32' || typeof python !== 'string' || !python.trim()) return python;
  const cacheKey = `${python}\0${preferWindowless ? 'w' : 'c'}\0${envPath}`;
  if (pythonCache.has(cacheKey)) return pythonCache.get(cacheKey);

  const findOnPath = name => {
    if (path.isAbsolute(name) || /[\\/]/.test(name)) {
      const resolved = path.resolve(name);
      return isRealFile(resolved) ? resolved : null;
    }
    const candidates = /\.[a-z0-9]+$/i.test(name) ? [name] : [`${name}.exe`, name];
    let fallback = null;
    for (const rawDir of envPath.split(';')) {
      const dir = rawDir.trim().replace(/^"|"$/g, '');
      if (!dir) continue;
      for (const file of candidates) {
        const full = path.join(dir, file);
        if (!isRealFile(full)) continue;
        if (/[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(full)) {
          fallback ||= full;
          continue;
        }
        return full;
      }
    }
    return fallback;
  };

  let resolved = findOnPath(python);
  if (!resolved) {
    pythonCache.set(cacheKey, python);
    return python;
  }

  // Unwrap venv / uv trampoline stubs (venvlauncher.exe), which spawn the real
  // python.exe without CREATE_NO_WINDOW and flash visible terminal windows on
  // every background check from a detached daemon.
  const dir = path.dirname(resolved);
  for (const cfgPath of [path.join(dir, '..', 'pyvenv.cfg'), path.join(dir, 'pyvenv.cfg')]) {
    try {
      if (!existsSync(cfgPath)) continue;
      const match = /^\s*home\s*=\s*(.+?)\s*$/m.exec(readFileSync(cfgPath, 'utf8'));
      const baseHome = match?.[1]?.trim();
      if (!baseHome) continue;
      const basePyw = path.join(baseHome, 'pythonw.exe');
      const basePy = path.join(baseHome, 'python.exe');
      if (preferWindowless && isRealFile(basePyw)) {
        pythonCache.set(cacheKey, basePyw);
        return basePyw;
      }
      if (isRealFile(basePy)) {
        pythonCache.set(cacheKey, basePy);
        return basePy;
      }
    } catch { /* keep resolved */ }
  }

  if (preferWindowless && /[\\/]python(?:3(?:\.\d+)?)?\.exe$/i.test(resolved)) {
    const siblingPyw = path.join(dir, 'pythonw.exe');
    if (isRealFile(siblingPyw)) resolved = siblingPyw;
  }
  pythonCache.set(cacheKey, resolved);
  return resolved;
}

export function childEnvironment(extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => environmentNames.has(key.toUpperCase())));
  return { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', NO_COLOR: '1', FORCE_COLOR: '0', ...extraEnv };
}

export function runProcess({ argv, cwd, input = '', relay = false, extraEnv = {}, python = process.platform === 'win32' ? 'python' : 'python3', timeoutMs = 30_000, onLine = () => {}, maxBytes = 1_048_576, retainBytes = maxBytes, windowsHide = true }) {
  let stopReason = null;
  let bytes = 0;
  let output = '';
  let stderr = '';
  let settled = false;
  let lineFailure = false;
  const trimTail = (text, limit) => Buffer.byteLength(text) <= limit ? text : text.slice(-Math.max(1024, Math.floor(limit * 0.75)));
  const pythonBin = resolveWindowsPython(python, { preferWindowless: windowsHide !== false });
  const child = spawn(pythonBin, ['-u', supervisor], { cwd, env: childEnvironment(extraEnv), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    else output = retainBytes < maxBytes ? trimTail(output + chunk, retainBytes) : output + chunk;
  });
  child.stderr.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) cancel('OUTPUT_LIMIT');
    else stderr = retainBytes < maxBytes ? trimTail(stderr + chunk, retainBytes) : stderr + chunk;
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
  child.stdin.write(JSON.stringify({ argv, cwd, input, relay, hide: windowsHide !== false }) + '\n');
  return { done, cancel, send: input => child.stdin.write(JSON.stringify({ input }) + '\n') };
}

export async function capture(argv, cwd, python, extraEnv = {}, timeoutMs = 15_000) {
  const result = await runProcess({ argv, cwd, python, extraEnv, timeoutMs }).done;
  if (result.stopReason) throw new PoolError(result.stopReason, 'CLI kontrolü tamamlanamadı. Kurulumu ve Python erişimini kontrol edin.');
  return result;
}
