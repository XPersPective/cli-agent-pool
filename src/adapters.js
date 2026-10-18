import { existsSync, readFileSync, realpathSync, statSync, accessSync, constants, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { capture, runProcess } from './process.js';
import { PoolError, redact, activeBillings, dataDirectory } from './config.js';
import { loadSecret, hasSecret } from './secrets-store.js';

export const adapterSpecs = [
  { adapter: 'codex', label: 'OpenAI Codex CLI', binaries: ['codex'], pkg: '@openai/codex', defaultBilling: 'subscription', loginCommand: 'codex login' },
  { adapter: 'claude', label: 'Anthropic Claude Code', binaries: ['claude'], pkg: '@anthropic-ai/claude-code', defaultBilling: 'subscription', loginCommand: 'claude auth login' },
  { adapter: 'opencode', label: 'OpenCode CLI', binaries: ['opencode'], pkg: 'opencode-ai', defaultBilling: 'free', loginCommand: 'opencode providers login' },
  { adapter: 'zcode', label: 'ZCode / Z.AI (GLM)', binaries: ['zcode'], pkg: null, defaultBilling: 'token_plan', loginCommand: 'zcode login zai' },
  { adapter: 'qwen', label: 'Qwen Code CLI', binaries: ['qwen'], pkg: '@qwen-code/qwen-code', defaultBilling: 'token_plan', loginCommand: 'qwen' },
  { adapter: 'mcode', label: 'MiniMax Code (mcode)', binaries: ['mcode'], pkg: '@minimax-ai/code', defaultBilling: 'token_plan', loginCommand: 'mcode login' },
  { adapter: 'mmx', label: 'MiniMax CLI (mmx)', binaries: ['mmx'], pkg: 'mmx-cli', defaultBilling: 'free_credits', loginCommand: 'mmx auth login' },
  { adapter: 'kimi', label: 'Moonshot Kimi Code', binaries: ['kimi'], pkg: null, defaultBilling: 'token_plan', loginCommand: 'kimi login' },
  { adapter: 'mimo', label: 'Xiaomi MiMoCode', binaries: ['mimo'], pkg: '@mimo-ai/cli', defaultBilling: 'token_plan', loginCommand: 'mimo providers login' },
  { adapter: 'agy', label: 'Google Antigravity CLI', binaries: ['agy', 'antigravity'], pkg: null, defaultBilling: 'subscription', loginCommand: 'agy' },
  { adapter: 'omniroute', label: 'OmniRoute Gateway CLI', binaries: ['omniroute'], pkg: 'omniroute', defaultBilling: 'token_plan', loginCommand: 'omniroute' },
  { adapter: 'lmstudio', label: 'LM Studio (Yerel)', binaries: ['lms', 'lmstudio'], pkg: null, defaultBilling: 'free', loginCommand: 'lms server start' },
  { adapter: 'ollama', label: 'Ollama (Yerel)', binaries: ['ollama'], pkg: null, defaultBilling: 'free', loginCommand: 'ollama list' },
  { adapter: 'aider', label: 'Aider CLI', binaries: ['aider'], pkg: null, defaultBilling: 'paid_api', loginCommand: 'aider' },
  { adapter: 'kilocode', label: 'Kilo Code CLI', binaries: ['kilocode', 'kilo'], pkg: null, defaultBilling: 'token_plan', loginCommand: 'kilocode' },
  { adapter: 'hermes', label: 'Hermes Agent CLI', binaries: ['hermes'], pkg: null, defaultBilling: 'free', loginCommand: 'hermes' },
];

export const loginCommands = Object.fromEntries([
  ...adapterSpecs.map(s => [s.adapter, s.loginCommand]),
  ['custom', ''],
]);

function readJsonSafe(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function npmEntry(directory, binName, pkgName) {
  if (!pkgName) return null;
  try {
    const root = path.join(directory, 'node_modules', pkgName);
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.[binName] || Object.values(pkg.bin || {})[0]);
    if (!bin) return null;
    const target = realpathSync(path.join(root, bin));
    return statSync(target).isFile() ? target : null;
  } catch { return null; }
}

function knownAdapterPaths(adapter) {
  const home = homedir();
  const localApp = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roamingApp = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const progFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const npmDir = path.join(roamingApp, 'npm');

  if (adapter === 'zcode') {
    return [
      path.join(progFiles, 'ZCode', 'resources', 'glm', 'zcode.cjs'),
      path.join(progFiles86, 'ZCode', 'resources', 'glm', 'zcode.cjs'),
      path.join(localApp, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    ];
  }
  if (adapter === 'mcode') {
    const paths = [];
    try {
      const currentFile = path.join(home, '.minimax-code', 'current');
      if (existsSync(currentFile)) {
        const rel = readFileSync(currentFile, 'utf8').trim();
        if (/^[0-9A-Za-z._-]+$/.test(rel)) {
          paths.push(path.join(home, '.minimax-code', 'releases', rel, 'node_modules', '@minimax-ai', 'code', 'cli.js'));
        }
      }
    } catch {}
    const entry = npmEntry(npmDir, 'mcode', '@minimax-ai/code');
    if (entry) paths.push(entry);
    return paths;
  }
  if (adapter === 'kimi') {
    return [path.join(home, '.kimi-code', 'bin', process.platform === 'win32' ? 'kimi.exe' : 'kimi')];
  }
  if (adapter === 'mimo') {
    const paths = [path.join(home, '.mimocode', 'bin', process.platform === 'win32' ? 'mimo.exe' : 'mimo')];
    const entry = npmEntry(npmDir, 'mimo', '@mimo-ai/cli');
    if (entry) paths.push(entry);
    return paths;
  }
  if (adapter === 'agy') {
    return [
      path.join(localApp, 'agy', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'),
      path.join(localApp, 'Programs', 'Antigravity IDE', 'resources', 'app', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'),
    ];
  }
  if (adapter === 'qwen') {
    const paths = [];
    const entry = npmEntry(npmDir, 'qwen', '@qwen-code/qwen-code');
    if (entry) paths.push(entry);
    paths.push(path.join(localApp, 'qwen-code', 'node_modules', '@qwen-code', 'qwen-code', 'cli-entry.js'));
    return paths;
  }
  if (adapter === 'omniroute') {
    const entry = npmEntry(npmDir, 'omniroute', 'omniroute');
    return entry ? [entry] : [];
  }
  if (adapter === 'lmstudio') {
    return [path.join(home, '.lmstudio', 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms')];
  }
  if (adapter === 'ollama') {
    return [path.join(localApp, 'Programs', 'Ollama', process.platform === 'win32' ? 'ollama.exe' : 'ollama')];
  }
  if (adapter === 'hermes') {
    return [path.join(localApp, 'hermes', 'hermes-agent', 'venv', 'Scripts', process.platform === 'win32' ? 'hermes.exe' : 'hermes')];
  }
  return [];
}

function findExecutableForSpec(spec) {
  for (const candidate of knownAdapterPaths(spec.adapter)) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {}
  }
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.ps1'] : [''];
  for (const directory of pathDirs) {
    if (!path.isAbsolute(directory)) continue; // Never discover a workspace-local command through relative PATH.
    for (const binName of spec.binaries) {
      for (const extension of extensions) {
        const candidate = path.join(directory, binName + extension);
        if (!existsSync(candidate)) continue;
        const resolved = /\.(cmd|ps1|bat)$/i.test(candidate) ? npmEntry(directory, binName, spec.pkg) : candidate;
        if (resolved && existsSync(resolved) && statSync(resolved).isFile()) {
          try { return realpathSync(resolved); } catch { return resolved; }
        }
      }
    }
  }
  return null;
}

export function localModelsFor(adapter) {
  const home = homedir();
  const models = [];
  const add = (id, alias, group = 'default', efforts = [], kinds = ['text', 'read', 'write'], free = false) => {
    if (!id || typeof id !== 'string' || id.length > 100 || /[\u0000-\u001f\u007f]/.test(id)) return;
    if (models.some(m => m.id === id)) return;
    models.push({
      id,
      alias: (alias || id).slice(0, 100),
      group: free ? 'free' : group,
      enabled: true,
      efforts,
      kinds: adapter === 'mmx' ? ['text'] : adapter === 'qwen' ? kinds.filter(k => k !== 'write') : kinds,
      free,
    });
  };

  if (adapter === 'zcode') {
    const cfg = readJsonSafe(path.join(home, '.zcode', 'v2', 'config.json'));
    const providers = cfg.provider && typeof cfg.provider === 'object' ? cfg.provider : {};
    for (const [provKey, provVal] of Object.entries(providers)) {
      if (!provVal || typeof provVal !== 'object' || provVal.enabled === false) continue;
      const provModels = provVal.models && typeof provVal.models === 'object' ? provVal.models : {};
      for (const [mKey, mVal] of Object.entries(provModels)) {
        const fullId = `${provKey}/${mKey}`;
        const isFree = /:free$|-free$/i.test(fullId);
        const label = mVal?.name ? `${mVal.name} (${provKey.replace(/^builtin:/, '')})` : fullId;
        add(fullId, label, isFree ? 'free' : 'zai-plan', [], ['text', 'read', 'write'], isFree);
      }
    }
    if (!models.length) {
      add('builtin:zai-coding-plan/GLM-5.3', 'GLM-5.3 (Z.AI Coding Plan)', 'zai-plan');
      add('builtin:zai-coding-plan/GLM-5.3-Flash', 'GLM-5.3-Flash (Z.AI Coding Plan)', 'zai-plan');
    }
  } else if (adapter === 'qwen') {
    const cfg = readJsonSafe(path.join(home, '.qwen', 'settings.json'));
    const selectedName = cfg.model?.name;
    const selectedBase = cfg.model?.baseUrl;
    if (typeof selectedName === 'string' && selectedName.trim()) {
      add(selectedName.trim(), `${selectedName.trim()} (Varsayılan)`, 'qwen-plan', [], ['text', 'read']);
    }
    const providers = cfg.modelProviders && typeof cfg.modelProviders === 'object' ? cfg.modelProviders : {};
    for (const rows of Object.values(providers)) {
      if (!Array.isArray(rows)) continue;
      for (const m of rows) {
        if (!m || typeof m.id !== 'string') continue;
        if (selectedBase && m.baseUrl && m.baseUrl !== selectedBase) continue;
        add(m.id, m.name || m.id, 'qwen-plan', [], ['text', 'read']);
      }
    }
    if (!models.length) add('qwen3-coder-plus', 'Qwen3 Coder Plus', 'qwen-plan', [], ['text', 'read']);
  } else if (adapter === 'opencode') {
    const cfg = readJsonSafe(path.join(home, '.config', 'opencode', 'opencode.json'));
    const providers = cfg.provider && typeof cfg.provider === 'object' ? cfg.provider : {};
    for (const [provKey, provVal] of Object.entries(providers)) {
      if (!provVal || typeof provVal !== 'object') continue;
      const provModels = provVal.models && typeof provVal.models === 'object' ? provVal.models : {};
      for (const [mKey, mVal] of Object.entries(provModels)) {
        const fullId = `${provKey}/${mKey}`;
        const isFree = /:free$|-free$/i.test(fullId);
        add(fullId, mVal?.name || fullId, isFree ? 'free' : provKey, [], ['text', 'read', 'write'], isFree);
      }
    }
    add('opencode/beam-free', 'Beam Free (Ücretsiz)', 'free', [], ['text', 'read', 'write'], true);
  } else if (adapter === 'codex') {
    const cache = readJsonSafe(path.join(home, '.codex', 'models_cache.json'));
    if (Array.isArray(cache.models)) {
      for (const row of cache.models) {
        if (row && typeof row.slug === 'string') {
          const efforts = Array.isArray(row.supported_reasoning_levels)
            ? row.supported_reasoning_levels.map(x => x.effort || x).filter(e => typeof e === 'string')
            : ['low', 'medium', 'high'];
          add(row.slug, row.display_name || row.slug, 'codex', efforts);
        }
      }
    }
  } else if (adapter === 'claude') {
    const cfg = readJsonSafe(path.join(home, '.claude', 'settings.json'));
    const envModel = cfg.env?.ANTHROPIC_MODEL || cfg.model;
    if (typeof envModel === 'string' && envModel.trim()) add(envModel.trim(), `${envModel.trim()} (Ayarlı)`, 'claude', ['low', 'medium', 'high']);
    add('sonnet', 'Claude Sonnet', 'claude', ['low', 'medium', 'high']);
    add('opus', 'Claude Opus', 'claude', ['low', 'medium', 'high']);
    add('haiku', 'Claude Haiku', 'claude', ['low', 'medium', 'high']);
  } else if (adapter === 'mcode') {
    try {
      const yaml = readFileSync(path.join(home, '.minimax', 'config.yaml'), 'utf8');
      const m = /^defaultModel:\s*([^\r\n]+)/m.exec(yaml);
      if (m?.[1]?.trim()) add(m[1].trim(), `${m[1].trim()} (MiniMax Code)`, 'minimax');
    } catch {}
    add('minimax/MiniMax-M3', 'MiniMax-M3 (MiniMax Code)', 'minimax');
    add('minimax/MiniMax-M2.7', 'MiniMax-M2.7 (MiniMax Code)', 'minimax');
  } else if (adapter === 'mmx') {
    add('MiniMax-M2.7', 'MiniMax-M2.7', 'minimax', [], ['text']);
  } else if (adapter === 'kimi') {
    try {
      const toml = readFileSync(path.join(home, '.kimi-code', 'config.toml'), 'utf8');
      const m = /^default_model\s*=\s*"([^"\r\n]+)"/m.exec(toml);
      if (m?.[1]?.trim()) add(m[1].trim(), `${m[1].trim()} (Kimi Code)`, 'kimi');
    } catch {}
    if (!models.length) add('kimi-code/k3-256k', 'Kimi K3 256k', 'kimi');
  } else if (adapter === 'mimo') {
    add('mimo/mimo-v2.5-pro', 'MiMo v2.5 Pro', 'mimo');
  } else if (adapter === 'agy') {
    add('gemini-2.5-pro', 'Gemini 2.5 Pro (Antigravity)', 'antigravity', ['low', 'medium', 'high']);
    add('gemini-2.5-flash', 'Gemini 2.5 Flash (Antigravity)', 'antigravity', ['low', 'medium', 'high']);
    add('gemini-3-flash', 'Gemini 3 Flash (Antigravity)', 'antigravity', ['low', 'medium', 'high']);
  } else if (adapter === 'omniroute') {
    add('default', 'OmniRoute Varsayılan', 'omniroute', ['low', 'medium', 'high']);
  } else if (adapter === 'lmstudio' || adapter === 'ollama') {
    add('default', `${adapter} Yerel Model`, 'local', [], ['text', 'read'], true);
  } else if (adapter === 'hermes' || adapter === 'aider' || adapter === 'kilocode') {
    add('default', `${adapter} Varsayılan`, adapter, [], ['text', 'read']);
  }
  return models.slice(0, 100);
}

export function importDiscoveredRoutes(config) {
  const cloned = structuredClone(config);
  const discovered = discover().filter(cli => cli.status === 'installed' && cli.executable);
  let addedRoutes = 0;
  let addedModels = 0;
  for (const cli of discovered) {
    let route = cloned.routes.find(r => r.adapter === cli.adapter && !r.api);
    if (!route) {
      let id = `${cli.adapter}-local`;
      let suffix = 2;
      while (cloned.routes.some(r => r.id === id)) id = `${cli.adapter}-local-${suffix++}`;
      route = {
        id,
        adapter: cli.adapter,
        executable: cli.executable,
        enabled: false,
        billing: cli.defaultBilling || 'token_plan',
        trustedSettings: cli.defaultBilling === 'free',
        priority: 100,
        maxConcurrent: 1,
        minRemainingPercent: 0,
        models: [],
      };
      cloned.routes.push(route);
      addedRoutes++;
    }
    for (const model of cli.discoveredModels || []) {
      if (!route.models.some(existing => existing.id === model.id) && route.models.length < 100) {
        const { free, ...cleanModel } = model;
        route.models.push(cleanModel);
        addedModels++;
      }
    }
  }
  return { config: cloned, addedRoutes, addedModels, discoveredCount: discovered.length };
}

export function discover() {
  return adapterSpecs.map(spec => {
    const executable = findExecutableForSpec(spec);
    const discoveredModels = executable ? localModelsFor(spec.adapter) : [];
    let defaultBilling = spec.defaultBilling;
    if (spec.adapter === 'claude' && executable) {
      const cfg = readJsonSafe(path.join(homedir(), '.claude', 'settings.json'));
      const base = cfg.env?.ANTHROPIC_BASE_URL;
      if (base && !/^https:\/\/api\.anthropic\.com\/?$/i.test(base)) defaultBilling = 'token_plan';
    }
    return {
      adapter: spec.adapter,
      label: spec.label,
      executable,
      status: executable ? 'installed' : 'not_found',
      auth: 'unknown',
      quota: 'unknown',
      defaultBilling,
      loginCommand: spec.loginCommand,
      discoveredModels,
    };
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
  } else if (route.adapter === 'opencode' || route.adapter === 'mimo') {
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
  if (Array.isArray(route.argsTemplate) && route.argsTemplate.length > 0) {
    const values = { model: model.id, effort: effort || 'default', workspace: task.workspace, prompt: task.prompt, kind: task.kind };
    const built = route.argsTemplate.map(token => token.replace(/\{(model|effort|workspace|prompt|kind)\}/g, (_, k) => String(values[k] ?? '')));
    return [...argv, ...built];
  }
  if (route.adapter === 'codex') return [...argv, '-a', 'never', 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json', '--sandbox', task.kind === 'write' ? 'workspace-write' : 'read-only', '-c', 'model_provider="openai"', '-m', model.id, ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []), '-'];
  if (route.adapter === 'claude') return [...argv, '-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', task.kind === 'write' ? 'acceptEdits' : 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', ...(route.api ? ['--setting-sources', 'user'] : []), '--tools', task.kind === 'text' ? '' : task.kind === 'read' ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write', '--model', model.id, ...(effort ? ['--effort', effort] : [])];
  if (route.adapter === 'opencode' || route.adapter === 'mimo') return [...argv, 'run', '--format', 'json', '--pure', '-m', opencodeModelId(route, model.id), '--agent', task.kind === 'text' ? 'summary' : task.kind === 'read' ? 'plan' : 'build', ...(effort ? ['--variant', effort] : [])];
  if (route.adapter === 'zcode') return [...argv, '--cwd', task.workspace, '--mode', task.kind === 'write' ? 'edit' : 'plan', '--disallowed-tools', task.kind === 'write' ? 'Bash' : 'Bash,Edit,Write', '--output-format', 'stream-json', '--no-color', '-p', task.prompt];
  if (route.adapter === 'mcode') return [...argv, 'exec', '--input', '-', '--cwd', task.workspace, '--model', model.id, '--prompt-mode', 'coding', '--permission', task.kind === 'write' ? 'full' : 'smart', '--mode', 'lightweight', '--output-format', 'stream-json', ...(effort ? ['--effort', effort] : [])];
  if (route.adapter === 'kimi') return [...argv, '-m', model.id, '--output-format', 'stream-json', ...(task.kind === 'write' ? ['--auto'] : []), '-p', task.prompt];
  if (route.adapter === 'agy') return [...argv, '-p', '--output-format', 'stream-json', '--mode', task.kind === 'write' ? 'accept-edits' : 'plan', '--disable-slash-commands', '--model', model.id, ...(effort ? ['--effort', effort] : [])];
  if (route.adapter === 'omniroute') return [...argv, 'chat', '--stdin', '--no-history', '-m', model.id, ...(effort ? ['--reasoning-effort', effort] : [])];
  if (route.adapter === 'mmx') return [...argv, 'text', 'chat', '--model', model.id, '--messages-file', '-', '--output', 'json'];
  if (route.adapter === 'qwen') {
    if (task.kind === 'write') throw new PoolError('WRITE_NOT_SUPPORTED', 'Bu adaptörde yazma görevi henüz doğrulanmadı.');
    return [...argv, '--model', model.id, '--output-format', 'stream-json', '--approval-mode', 'plan'];
  }
  if (route.adapter === 'ollama') return [...argv, 'run', model.id];
  if (route.adapter === 'aider') return [...argv, '--model', model.id, '--yes-always', '--no-auto-commits', '--message', task.prompt];
  throw new PoolError('UNSUPPORTED_ADAPTER', 'Bu CLI için çalıştırma şablonu (argsTemplate) tanımlanmalı.');
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
  } else if (route.adapter === 'opencode' || route.adapter === 'mimo' || route.adapter === 'lmstudio' || route.adapter === 'ollama') {
    if (route.billing !== 'free' && !route.trustedSettings) throw new PoolError('SETTINGS_NOT_TRUSTED', 'Yerel CLI ayarları incelenerek trustedSettings etkinleştirilmeli.');
  } else {
    if (!route.trustedSettings) throw new PoolError('SETTINGS_NOT_TRUSTED', 'Bu bağlantının abonelik/plan ve CLI ayarları yerel olarak doğrulanmalı.');
    if (route.adapter === 'mmx') {
      const snapshot = await quota(route, cwd, python, directory);
      if ((route.billing === 'subscription' || route.billing === 'token_plan') && snapshot.subscription !== 'active') {
        throw new PoolError('SUBSCRIPTION_REQUIRED', 'mmx için etkin token plan aboneliği doğrulanamadı. Günlük/ücretsiz kredileri kullanmak için bağlantı ödeme türünü free_credits olarak seçin.');
      }
      if (snapshot.auth === 'missing') throw new PoolError('AUTH_REQUIRED', `mmx içinde giriş yapın (${loginCommands.mmx}).`);
    }
  }
}

const strictJsonlAdapters = new Set(['codex', 'claude', 'qwen', 'opencode', 'mimo']);
const promptArgAdapters = new Set(['zcode', 'kimi', 'aider']);

export function execute(route, model, task, python, progress, directory = dataDirectory()) {
  let answer = '';
  let rawLines = [];
  let productError = false;
  let sawResult = false;
  const argv = buildArguments(route, model, task);
  const extraEnv = routeEnvironment(route, directory, task.kind);
  const usesStdin = route.promptStdin ?? !promptArgAdapters.has(route.adapter);
  const input = !usesStdin ? '' : route.adapter === 'mmx' ? JSON.stringify([{ role: 'user', content: task.prompt }]) : task.prompt;
  const process = runProcess({ argv, cwd: task.workspace, input, extraEnv, python, timeoutMs: task.timeoutSeconds * 1000,
    onLine(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch {
        if (strictJsonlAdapters.has(route.adapter)) throw new Error('Invalid JSONL');
        rawLines.push(line);
        return;
      }
      if (route.adapter === 'codex') {
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer = event.item.text || '';
        if (event.type === 'turn.completed') sawResult = true;
        if (event.type === 'turn.failed' || event.type === 'error') productError = true;
      } else if (route.adapter === 'opencode' || route.adapter === 'mimo') {
        if (event.type === 'text' && event.part?.text) answer += event.part.text;
        if (event.type === 'step_finish') sawResult = true;
        if (event.type === 'error') productError = true;
      } else {
        if (event.type === 'result') {
          answer = event.result || event.response || event.text || answer;
          productError = Boolean(event.is_error || event.error);
          sawResult = true;
        } else if (event.type === 'text' && (event.text || event.part?.text)) {
          answer += event.text || event.part.text;
        } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          const textPart = event.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
          if (textPart) answer = textPart;
        }
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
      } else if (!sawResult && !strictJsonlAdapters.has(route.adapter) && result.code === 0 && !result.stopReason) {
        const fallback = answer.trim() || rawLines.join('\n').trim() || result.output.trim();
        if (fallback) { answer = fallback; sawResult = true; }
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

export async function routeCatalog(route, cwd, python) {
  if (route.adapter === 'opencode' || route.adapter === 'mimo') {
    try {
      const live = await opencodeCatalog(route, cwd, python);
      const local = localModelsFor(route.adapter).filter(m => route.billing !== 'free' || m.free);
      const merged = [...live.models];
      for (const item of local) {
        if (!merged.some(m => m.id === item.id)) {
          merged.push({ id: item.id, name: item.alias, free: Boolean(item.free), efforts: item.efforts || [], defaultEffort: null });
        }
      }
      return { connection: route.id, models: merged.slice(0, 100), nextCursor: null };
    } catch {
      const fallback = localModelsFor(route.adapter);
      return { connection: route.id, models: fallback.map(m => ({ id: m.id, name: m.alias, free: Boolean(m.free), efforts: m.efforts || [], defaultEffort: null })), nextCursor: null };
    }
  }
  const discovered = localModelsFor(route.adapter);
  return {
    connection: route.id,
    models: discovered.map(m => ({ id: m.id, name: m.alias, free: Boolean(m.free), efforts: m.efforts || [], defaultEffort: null })),
    nextCursor: null,
  };
}

let cclimitsCache = { at: 0, data: null };
async function readCclimitsCached(cwd, python) {
  if (Date.now() - cclimitsCache.at < 15_000 && cclimitsCache.data) return cclimitsCache.data;
  const roamingApp = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
  const ccPy = path.join(roamingApp, 'npm', 'node_modules', 'cclimits', 'lib', 'cclimits.py');
  if (!existsSync(ccPy)) return null;
  try {
    const res = await capture([python, ccPy, '--json', '--cached'], cwd, python);
    if (res.code === 0 && res.output.trim()) {
      cclimitsCache = { at: Date.now(), data: JSON.parse(res.output) };
      return cclimitsCache.data;
    }
  } catch {}
  return null;
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
  if (route.adapter === 'zcode') {
    const cc = await readCclimitsCached(cwd, python);
    const zai = cc?.zai;
    if (zai?.status === 'ok' && Array.isArray(zai.quota_windows)) {
      const windows = zai.quota_windows.map(w => ({ name: w.name, remainingPercent: Number(w.remaining_pct), resetsAt: w.resets_at || null }));
      const limited = windows.some(w => w.remainingPercent <= 0);
      return { ...base, status: limited ? 'rate_limited' : 'available', auth: `zai (${zai.plan || 'plan'})`, windows, source: 'cclimits-zai' };
    }
    const hasModels = localModelsFor('zcode').length > 0;
    return { ...base, status: hasModels ? 'available' : 'unknown', auth: hasModels ? 'zcode-config' : 'unknown', windows: [], source: 'zcode' };
  }
  if (route.adapter === 'agy') {
    const cc = await readCclimitsCached(cwd, python);
    const ag = cc?.antigravity;
    if (ag?.status === 'ok' && Array.isArray(ag.quota_groups)) {
      const windows = ag.quota_groups.flatMap(g => Object.entries(g.buckets || {}).map(([k, v]) => ({
        name: `${g.short_name || g.name}:${k}`,
        remainingPercent: Number(v.remaining_pct),
        resetsAt: v.reset_time || null,
      })));
      return { ...base, status: 'available', auth: ag.subscription_tier || 'antigravity', windows, source: 'cclimits-antigravity' };
    }
    return { ...base, status: 'available', auth: 'configured', windows: [], source: 'antigravity' };
  }
  if (route.adapter === 'kimi') {
    const cc = await readCclimitsCached(cwd, python);
    const km = cc?.kimi_code;
    if (km?.error) return { ...base, status: 'auth_required', auth: km.error, windows: [], source: 'cclimits-kimi' };
    return { ...base, status: 'available', auth: 'configured', windows: [], source: 'kimi' };
  }
  if (route.adapter === 'mcode') {
    const hasCreds = existsSync(path.join(homedir(), '.minimax', 'local-runtime.auth.json'));
    return { ...base, status: hasCreds ? 'available' : 'unknown', auth: hasCreds ? 'minimax_login' : 'unknown', windows: [], source: 'mcode' };
  }
  if (route.adapter === 'opencode' || route.adapter === 'mimo' || route.adapter === 'lmstudio' || route.adapter === 'ollama') {
    return { ...base, status: 'available', auth: route.billing === 'free' ? 'builtin_free' : 'configured', windows: [], source: route.adapter };
  }
  if (route.adapter === 'qwen' || route.adapter === 'omniroute' || route.adapter === 'aider' || route.adapter === 'kilocode' || route.adapter === 'hermes' || route.adapter === 'custom') {
    return { ...base, status: route.trustedSettings ? 'available' : 'unknown', auth: route.trustedSettings ? 'configured' : 'unverified', windows: [], source: route.adapter };
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
