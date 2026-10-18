import { existsSync, readFileSync, realpathSync, statSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { capture, runProcess } from './process.js';
import { PoolError, redact } from './config.js';

const names = ['codex', 'claude', 'gemini', 'qwen', 'mmx'];
const packages = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code', gemini: '@google/gemini-cli', qwen: '@qwen-code/qwen-code', mmx: 'mmx-cli' };

function npmEntry(directory, name) {
  try {
    const root = path.join(directory, 'node_modules', packages[name]);
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name];
    if (!bin) return null;
    const target = realpathSync(path.join(root, bin));
    if (!statSync(target).isFile()) return null;
    return target;
  } catch { return null; }
}

export function discover() {
  return names.map(name => {
    for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      if (!path.isAbsolute(directory)) continue; // Never discover a workspace-local command through relative PATH.
      const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.ps1'] : [''];
      for (const extension of extensions) {
        const candidate = path.join(directory, name + extension);
        if (!existsSync(candidate)) continue;
        const executable = /\.(cmd|ps1)$/i.test(candidate) ? npmEntry(directory, name) : candidate;
        if (executable) return { adapter: name, executable: realpathSync(executable), status: 'installed', auth: 'unknown', quota: 'unknown' };
      }
    }
    return { adapter: name, executable: null, status: 'not_found', auth: 'unknown', quota: 'unknown' };
  });
}

export function executableArgv(executable) {
  if (!path.isAbsolute(executable) || !existsSync(executable) || !statSync(executable).isFile()) throw new PoolError('EXECUTABLE_MISSING', 'CLI dosyasını yeniden seçin.');
  if (/\.(?:cmd|bat|ps1)$/i.test(executable)) throw new PoolError('SHELL_SHIM_DENIED', 'Shell kısayolu yerine gerçek .exe veya JavaScript CLI giriş dosyasını seçin.');
  if (process.platform !== 'win32') accessSync(executable, /\.[cm]?js$/i.test(executable) ? constants.R_OK : constants.X_OK);
  return /\.[cm]?js$/i.test(executable) ? [process.execPath, executable] : [executable];
}

export function buildArguments(route, model, task) {
  const argv = executableArgv(route.executable);
  const effort = task.effort;
  if (route.adapter === 'codex') return [...argv, '-a', 'never', 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json', '--sandbox', task.kind === 'write' ? 'workspace-write' : 'read-only', '-c', 'model_provider="openai"', '-m', model.id, ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []), '-'];
  if (route.adapter === 'claude') return [...argv, '-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', task.kind === 'write' ? 'acceptEdits' : 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--tools', task.kind === 'text' ? '' : task.kind === 'read' ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write', '--model', model.id, ...(effort ? ['--effort', effort] : [])];
  if (route.adapter === 'mmx') return [...argv, 'text', 'chat', '--model', model.id, '--messages-file', '-', '--output', 'json'];
  if (route.adapter === 'gemini' || route.adapter === 'qwen') {
    if (task.kind === 'write') throw new PoolError('WRITE_NOT_SUPPORTED', 'Bu adaptörde yazma görevi henüz doğrulanmadı.');
    return [...argv, '--model', model.id, '--output-format', 'stream-json', '--approval-mode', 'plan'];
  }
  throw new PoolError('UNSUPPORTED_ADAPTER', 'Bu CLI desteklenmiyor.');
}

export async function checkAuth(route, cwd, python) {
  if (route.billing !== 'subscription') throw new PoolError('BILLING_UNCONFIRMED', 'Abonelik bağlantısı yerel ayarlarda doğrulanmalı.');
  const argv = executableArgv(route.executable);
  if (route.adapter === 'codex') {
    const result = await capture([...argv, 'login', 'status'], cwd, python);
    if (result.code !== 0 || !/Logged in using ChatGPT/i.test(result.output + result.stderr)) throw new PoolError('AUTH_REQUIRED', 'Codex CLI içinde ChatGPT hesabınızla giriş yapın.');
  } else if (route.adapter === 'claude') {
    if (!route.trustedSettings) throw new PoolError('SETTINGS_NOT_TRUSTED', 'Claude yerel ayarları ve hook’ları incelenerek trustedSettings etkinleştirilmeli.');
    const result = await capture([...argv, 'auth', 'status', '--json'], cwd, python);
    let status;
    try { status = JSON.parse(result.output); } catch { /* Fail closed on CLI protocol drift. */ }
    if (result.code !== 0 || !status?.loggedIn || status.authMethod !== 'claude.ai') throw new PoolError('AUTH_REQUIRED', 'Claude Code içinde abonelik hesabınızla giriş yapın.');
  } else if (!route.trustedSettings) throw new PoolError('SETTINGS_NOT_TRUSTED', 'Bu bağlantının abonelik ve CLI ayarları yerel olarak doğrulanmalı.');
}

export function execute(route, model, task, python, progress) {
  let answer = '';
  let productError = false;
  let sawResult = false;
  const argv = buildArguments(route, model, task);
  const input = route.adapter === 'mmx' ? JSON.stringify([{ role: 'user', content: task.prompt }]) : task.prompt;
  const process = runProcess({ argv, cwd: task.workspace, input, python, timeoutMs: task.timeoutSeconds * 1000,
    onLine(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { if (route.adapter !== 'mmx') throw new Error('Invalid JSONL'); return; }
      if (route.adapter === 'codex') {
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer = event.item.text || '';
        if (event.type === 'turn.completed') sawResult = true;
        if (event.type === 'turn.failed' || event.type === 'error') productError = true;
      } else if (route.adapter === 'claude') {
        if (event.type === 'result') { answer = event.result || ''; productError = Boolean(event.is_error); sawResult = true; }
      } else if (route.adapter === 'gemini' || route.adapter === 'qwen') {
        if (event.type === 'message' && event.role === 'assistant') answer += event.content || '';
        if (event.type === 'result') { sawResult = true; productError = event.status === 'error' || Boolean(event.error); }
      }
      // Persist lifecycle only: raw tool inputs, stderr and intermediate text stay out of events.
      if (['thread.started', 'turn.started', 'system', 'init'].includes(event.type)) progress('started');
    },
  });
  return {
    cancel: process.cancel,
    done: process.done.then(result => {
      if (route.adapter === 'mmx' && result.code === 0 && !result.stopReason) {
        try {
          const json = JSON.parse(result.output);
          const body = json.data || json;
          answer = (body.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
          sawResult = Boolean(answer);
          productError = Boolean(json.error || body.base_resp?.status_code);
        } catch { productError = true; }
      }
      if (result.stopReason) return { error: result.stopReason };
      if (result.code !== 0 || productError) return { error: 'CLI_FAILED' };
      if (!sawResult || !answer.trim()) return { error: 'INVALID_RESULT' };
      return { result: redact(answer) };
    }),
  };
}

export async function quota(route, cwd, python) {
  if (route.adapter !== 'mmx') return { connection: route.id, status: 'unknown', windows: [], source: 'unsupported', observedAt: new Date().toISOString() };
  const result = await capture([...executableArgv(route.executable), 'quota', 'show', '--output', 'json'], cwd, python);
  if (result.code !== 0) return { connection: route.id, status: 'unknown', windows: [], source: 'mmx', observedAt: new Date().toISOString() };
  // Preserve the vendor's units instead of guessing percentages from token usage.
  try { return { connection: route.id, status: 'unknown', windows: [], source: 'mmx', vendor: redact(result.output), observedAt: new Date().toISOString() }; }
  catch { throw new PoolError('INVALID_QUOTA', 'Kota yanıtı okunamadı.'); }
}
