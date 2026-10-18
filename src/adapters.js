import { existsSync, readFileSync, realpathSync, statSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { capture, runProcess } from './process.js';
import { PoolError, redact, activeBillings, dataDirectory } from './config.js';
import { loadSecret, hasSecret } from './secrets-store.js';

const names = ['codex', 'claude', 'qwen', 'opencode', 'mmx'];
const packages = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code', qwen: '@qwen-code/qwen-code', opencode: 'opencode-ai', mmx: 'mmx-cli' };

export const loginCommands = {
  codex: 'codex login',
  claude: 'claude auth login',
  qwen: 'qwen',
  opencode: 'opencode providers login',
  mmx: 'mmx auth login',
};

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
        if (executable) return { adapter: name, executable: realpathSync(executable), status: 'installed', auth: 'unknown', quota: 'unknown', loginCommand: loginCommands[name] };
      }
    }
    return { adapter: name, executable: null, status: 'not_found', auth: 'unknown', quota: 'unknown', loginCommand: loginCommands[name] };
  });
}

export function executableArgv(executable) {
  if (!path.isAbsolute(executable) || !existsSync(executable) || !statSync(executable).isFile()) throw new PoolError('EXECUTABLE_MISSING', 'CLI dosyasını yeniden seçin.');
  if (/\.(?:cmd|bat|ps1)$/i.test(executable)) throw new PoolError('SHELL_SHIM_DENIED', 'Shell kısayolu yerine gerçek .exe veya JavaScript CLI giriş dosyasını seçin.');
  if (process.platform !== 'win32') accessSync(executable, /\.[cm]?js$/i.test(executable) ? constants.R_OK : constants.X_OK);
  return /\.[cm]?js$/i.test(executable) ? [process.execPath, executable] : [executable];
}

export function opencodeModelId(route, modelId) {
  if (!route.api) return modelId;
  const providerId = `pool_${route.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const rawId = modelId.includes('/') ? modelId.slice(modelId.indexOf('/') + 1) : modelId;
  return `${providerId}/${rawId}`;
}

export function routeEnvironment(route, directory = dataDirectory(), taskKind = 'read') {
  const extra = {};
  if (route.api) {
    const secret = route.api.secretRef ? loadSecret(directory, route.api.secretRef) : null;
    if (route.api.protocol === 'anthropic') {
      extra.ANTHROPIC_BASE_URL = route.api.baseUrl;
      if (secret) extra.ANTHROPIC_AUTH_TOKEN = secret;
    } else if (route.api.protocol === 'openai') {
      const providerId = `pool_${route.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      const models = Object.fromEntries((route.models || []).map(m => {
        const rawId = m.id.includes('/') ? m.id.slice(m.id.indexOf('/') + 1) : m.id;
        return [rawId, { name: m.alias || rawId, tool_call: true }];
      }));
      const permission = taskKind === 'write'
        ? { question: 'deny', external_directory: 'deny' }
        : { bash: 'deny', edit: 'deny', write: 'deny', question: 'deny', external_directory: 'deny' };
      extra.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        permission,
        provider: {
          [providerId]: {
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: route.api.baseUrl, ...(secret ? { apiKey: secret } : {}) },
            models,
          },
        },
      });
    }
  } else if (route.adapter === 'opencode') {
    const permission = taskKind === 'write'
      ? { question: 'deny', external_directory: 'deny' }
      : { bash: 'deny', edit: 'deny', write: 'deny', question: 'deny', external_directory: 'deny' };
    extra.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission });
  }
  return extra;
}

export function buildArguments(route, model, task) {
  const argv = executableArgv(route.executable);
  const effort = task.effort;
  if (route.adapter === 'codex') return [...argv, '-a', 'never', 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json', '--sandbox', task.kind === 'write' ? 'workspace-write' : 'read-only', '-c', 'model_provider="openai"', '-m', model.id, ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []), '-'];
  if (route.adapter === 'claude') return [...argv, '-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', task.kind === 'write' ? 'acceptEdits' : 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', ...(route.api ? ['--setting-sources', 'user'] : []), '--tools', task.kind === 'text' ? '' : task.kind === 'read' ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write', '--model', model.id, ...(effort ? ['--effort', effort] : [])];
  if (route.adapter === 'opencode') return [...argv, 'run', '--format', 'json', '--pure', '-m', opencodeModelId(route, model.id), '--agent', task.kind === 'text' ? 'summary' : task.kind === 'read' ? 'plan' : 'build', ...(effort ? ['--variant', effort] : [])];
  if (route.adapter === 'mmx') return [...argv, 'text', 'chat', '--model', model.id, '--messages-file', '-', '--output', 'json'];
  if (route.adapter === 'qwen') {
    if (task.kind === 'write') throw new PoolError('WRITE_NOT_SUPPORTED', 'Bu adaptörde yazma görevi henüz doğrulanmadı.');
    return [...argv, '--model', model.id, '--output-format', 'stream-json', '--approval-mode', 'plan'];
  }
  throw new PoolError('UNSUPPORTED_ADAPTER', 'Bu CLI desteklenmiyor.');
}

export async function checkAuth(route, cwd, python, directory = dataDirectory()) {
  if (!activeBillings.has(route.billing)) throw new PoolError('BILLING_UNCONFIRMED', 'Ödeme türü yerel ayarlarda doğrulanmalı.');
  const argv = executableArgv(route.executable);
  if (route.api) {
    if (route.api.secretRef && !hasSecret(directory, route.api.secretRef)) {
      throw new PoolError('SECRET_MISSING', `API bağlantısı (${route.id}) için anahtar kaydedilmemiş. Yönetim ekranından API anahtarını girin.`);
    }
    return;
  }
  if (route.adapter === 'codex') {
    const result = await capture([...argv, 'login', 'status'], cwd, python);
    if (result.code !== 0 || !/Logged in using ChatGPT/i.test(result.output + result.stderr)) throw new PoolError('AUTH_REQUIRED', `Codex CLI içinde hesabınızla giriş yapın (${loginCommands.codex}).`);
  } else if (route.adapter === 'claude') {
    if (!route.trustedSettings) throw new PoolError('SETTINGS_NOT_TRUSTED', 'Claude yerel ayarları ve hook’ları incelenerek trustedSettings etkinleştirilmeli.');
    const result = await capture([...argv, 'auth', 'status', '--json'], cwd, python);
    let status;
    try { status = JSON.parse(result.output); } catch { /* Fail closed on CLI protocol drift. */ }
    if (result.code !== 0 || !status?.loggedIn) throw new PoolError('AUTH_REQUIRED', `Claude Code içinde giriş yapın (${loginCommands.claude}).`);
    const text = await capture([...argv, 'auth', 'status', '--text'], cwd, python);
    const endpoint = /base URL:\s*(\S+)/i.exec(text.output + text.stderr)?.[1];
    const thirdParty = endpoint && !/^https:\/\/api\.anthropic\.com\/?$/i.test(endpoint);
    if (route.billing === 'subscription') {
      if (status.authMethod !== 'claude.ai') throw new PoolError('AUTH_REQUIRED', `Claude aboneliği için claude.ai hesabıyla giriş yapın (${loginCommands.claude}) veya bağlantı ödeme türünü token_plan / paid_api olarak seçin.`);
      if (text.code !== 0 || thirdParty) throw new PoolError('THIRD_PARTY_ENDPOINT', 'Claude Code başka bir API adresine yönlendirilmiş. Bu bağlantıyı kullanmak için ödeme türünü token_plan veya paid_api olarak ayarlayın.');
    }
  } else if (route.adapter === 'opencode') {
    if (route.billing !== 'free' && !route.trustedSettings) throw new PoolError('SETTINGS_NOT_TRUSTED', 'OpenCode yerel ayarları incelenerek trustedSettings etkinleştirilmeli.');
  } else {
    if (!route.trustedSettings) throw new PoolError('SETTINGS_NOT_TRUSTED', 'Bu bağlantının abonelik/plan ve CLI ayarları yerel olarak doğrulanmalı.');
    if (route.adapter === 'mmx') {
      const snapshot = await quota(route, cwd, python);
      if ((route.billing === 'subscription' || route.billing === 'token_plan') && snapshot.subscription !== 'active') {
        throw new PoolError('SUBSCRIPTION_REQUIRED', 'mmx için etkin token plan aboneliği doğrulanamadı. Günlük/ücretsiz kredileri kullanmak için bağlantı ödeme türünü free_credits olarak seçin.');
      }
      if (snapshot.auth === 'missing') throw new PoolError('AUTH_REQUIRED', `mmx içinde giriş yapın (${loginCommands.mmx}).`);
    }
  }
}

export function execute(route, model, task, python, progress, directory = dataDirectory()) {
  let answer = '';
  let productError = false;
  let sawResult = false;
  const argv = buildArguments(route, model, task);
  const extraEnv = routeEnvironment(route, directory, task.kind);
  const input = route.adapter === 'mmx' ? JSON.stringify([{ role: 'user', content: task.prompt }]) : task.prompt;
  const process = runProcess({ argv, cwd: task.workspace, input, extraEnv, python, timeoutMs: task.timeoutSeconds * 1000,
    onLine(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { if (route.adapter !== 'mmx') throw new Error('Invalid JSONL'); return; }
      if (route.adapter === 'codex') {
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer = event.item.text || '';
        if (event.type === 'turn.completed') sawResult = true;
        if (event.type === 'turn.failed' || event.type === 'error') productError = true;
      } else if (route.adapter === 'claude' || route.adapter === 'qwen') {
        if (event.type === 'result') { answer = event.result || ''; productError = Boolean(event.is_error); sawResult = true; }
      } else if (route.adapter === 'opencode') {
        if (event.type === 'text' && event.part?.text) answer += event.part.text;
        if (event.type === 'step_finish') sawResult = true;
        if (event.type === 'error') productError = true;
      }
      if (['thread.started', 'turn.started', 'system', 'init', 'step_start'].includes(event.type)) progress('started');
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

export async function opencodeCatalog(route, cwd, python) {
  const argv = [...executableArgv(route.executable), 'models', '--verbose', '--pure'];
  const result = await runProcess({ argv, cwd, python, timeoutMs: 25_000, maxBytes: 16_777_216 }).done;
  if (result.stopReason || result.code !== 0) throw new PoolError('DISCOVERY_FAILED', 'OpenCode model listesi alınamadı.');
  const blocks = result.output.split(/\r?\n(?=[a-zA-Z0-9_.-]+\/)/);
  const models = [];
  for (const block of blocks) {
    const brace = block.indexOf('{');
    if (brace < 0) continue;
    const id = block.slice(0, brace).trim();
    if (!id.includes('/')) continue;
    try {
      const meta = JSON.parse(block.slice(brace));
      const provider = id.slice(0, id.indexOf('/'));
      const free = meta.cost?.input === 0 && meta.cost?.output === 0 && (provider === 'opencode' || id.endsWith(':free') || /-free$/i.test(id));
      if (route.billing === 'free' ? !free : (provider === 'openrouter' && !free)) continue;
      models.push({
        id,
        name: `${meta.name || id}${free ? ' (Ücretsiz)' : ''}`,
        free,
        provider,
        efforts: Object.keys(meta.variants || {}).slice(0, 10),
        defaultEffort: null,
      });
    } catch { /* Ignore malformed entries */ }
  }
  return { connection: route.id, models: models.slice(0, 100), nextCursor: null };
}

export async function quota(route, cwd, python, directory = dataDirectory()) {
  const observedAt = new Date().toISOString();
  const base = { connection: route.id, adapter: route.adapter, billing: route.billing, loginCommand: loginCommands[route.adapter], observedAt };
  if (route.api) {
    const configured = !route.api.secretRef || hasSecret(directory, route.api.secretRef);
    return { ...base, status: configured ? 'available' : 'auth_required', auth: configured ? 'api_key' : 'missing', endpoint: route.api.baseUrl, protocol: route.api.protocol, windows: [], source: 'custom-api' };
  }
  const argv = executableArgv(route.executable);
  if (route.adapter === 'claude') {
    const statusRes = await capture([...argv, 'auth', 'status', '--json'], cwd, python);
    const textRes = await capture([...argv, 'auth', 'status', '--text'], cwd, python);
    let status = {};
    try { status = JSON.parse(statusRes.output); } catch {}
    const endpoint = /base URL:\s*(\S+)/i.exec(textRes.output + textRes.stderr)?.[1] || 'https://api.anthropic.com';
    const loggedIn = statusRes.code === 0 && Boolean(status?.loggedIn);
    return { ...base, status: loggedIn ? 'available' : 'auth_required', auth: loggedIn ? (status.authMethod || 'logged_in') : 'missing', endpoint, windows: [], source: 'claude-auth' };
  }
  if (route.adapter === 'opencode') {
    return { ...base, status: 'available', auth: route.billing === 'free' ? 'builtin_free' : 'configured', windows: [], source: 'opencode' };
  }
  if (route.adapter === 'qwen') {
    return { ...base, status: 'unknown', auth: route.trustedSettings ? 'configured' : 'unverified', windows: [], source: 'qwen' };
  }
  if (route.adapter !== 'mmx') return { ...base, status: 'unknown', windows: [], source: 'unsupported' };
  const authRes = await capture([...argv, 'auth', 'status', '--output', 'json'], cwd, python);
  let authJson = {};
  try { authJson = JSON.parse(authRes.output); } catch {}
  const loggedIn = authRes.code === 0 && Boolean(authJson?.method);
  const result = await capture([...argv, 'quota', 'show', '--output', 'json'], cwd, python);
  let body;
  try { body = JSON.parse(result.output); } catch { /* Unknown output never proves an active plan. */ }
  const failure = result.code !== 0 || !body || body.error || body.base_resp?.status_code;
  const subscription = !failure ? 'active' : /no active (?:token )?plan/i.test(result.output + result.stderr) ? 'none' : 'unknown';
  const status = !loggedIn ? 'auth_required' : (subscription === 'active' || route.billing === 'free_credits' || route.billing === 'paid_api') ? 'available' : 'unknown';
  return { ...base, status, auth: loggedIn ? authJson.method : 'missing', subscription, windows: [], source: 'mmx', ...(failure ? {} : { vendor: redact(result.output) }) };
}
