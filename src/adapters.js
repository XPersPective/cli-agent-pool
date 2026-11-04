import { modelFiltered } from '../web/pool-state.js';
import { agyProjectArguments } from './agy-project.js';
import { zcodePlanConfig, zcodePlanFile } from './zcode-plan.js';
import { taskPrompt, executionReportJsonSchema, parseExecutionReport } from './task-protocol.js';
import { existsSync, readFileSync, realpathSync, statSync, accessSync, constants, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, runProcess } from './process.js';
import { PoolError, redact, activeBillings, dataDirectory } from './config.js';
import { loadSecret, hasSecret } from './secrets-store.js';
import { claudeQuota, zaiQuota, zaiKeys, kimiLoggedIn, antigravityQuota, kimiQuota, minimaxQuota, minimaxWindows, openrouterQuota, apiRouteQuota } from './quotas.js';
import { profileEnvironment, profileHome, claudeConfigDirectory, wslPrefix, wslProfileHome, wslWindowsPath, wslUriToWindows } from './profiles.js';

export const adapterSpecs = [
  { adapter: 'codex', label: 'OpenAI Codex CLI', binaries: ['codex'], pkg: '@openai/codex', defaultBilling: 'subscription', loginCommand: 'codex login' },
  { adapter: 'claude', label: 'Anthropic Claude Code', binaries: ['claude'], pkg: '@anthropic-ai/claude-code', defaultBilling: 'subscription', loginCommand: 'claude auth login' },
  { adapter: 'opencode', label: 'OpenCode CLI', binaries: ['opencode'], pkg: 'opencode-ai', defaultBilling: 'free', loginCommand: 'opencode providers login' },
  { adapter: 'zcode', label: 'ZCode / Z.AI (GLM)', binaries: ['zcode'], pkg: null, defaultBilling: 'token_plan', loginCommand: 'zcode login zai' },
  { adapter: 'qoder', label: 'Qoder CLI (Account Credits)', binaries: ['qoder', 'qodercli'], pkg: '@qoder-ai/qodercli', defaultBilling: 'free_credits', loginCommand: 'qodercli login' },
  { adapter: 'qwen', label: 'Qwen Code CLI', binaries: ['qwen'], pkg: '@qwen-code/qwen-code', defaultBilling: 'token_plan', loginCommand: 'qwen' },
  { adapter: 'mcode', label: 'MiniMax Code (mcode)', binaries: ['mcode'], pkg: '@minimax-ai/code', defaultBilling: 'token_plan', loginCommand: 'mcode login --region global' },
  { adapter: 'mmx', label: 'MiniMax CLI (mmx)', binaries: ['mmx'], pkg: 'mmx-cli', defaultBilling: 'token_plan', loginCommand: 'mmx auth login --recommend --region=global' },
  { adapter: 'kimi', label: 'Moonshot Kimi Code', binaries: ['kimi'], pkg: null, defaultBilling: 'token_plan', loginCommand: 'kimi login --region global' },
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

// Qwen stores provider credentials in its own settings/env resolver instead of
// returning an OAuth token to the launcher. Inspect only presence, never value.
function qwenEnvValue(filePath, envKey) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey || '')) return false;
  try {
    for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match?.[1] !== envKey) continue;
      const value = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted ?? '');
      return value.trim() && !value.startsWith('#') ? value.trim() : null;
    }
  } catch { /* A missing dotenv file is not an auth error by itself. */ }
  return null;
}

function qwenProjectEnvValue(cwd, home, envKey) {
  let current = path.resolve(cwd);
  const homeDir = path.resolve(home);
  for (let depth = 0; depth < 32; depth++) {
    if (current === homeDir) break;
    const value = qwenEnvValue(path.join(current, '.qwen', '.env'), envKey) || qwenEnvValue(path.join(current, '.env'), envKey);
    if (value) return value;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function qwenProviderContext(home, env, requestedModelId, cwd) {
  const qwenDir = env.QWEN_HOME ? path.resolve(env.QWEN_HOME) : path.join(home, '.qwen');
  const cfg = readJsonSafe(path.join(qwenDir, 'settings.json'));
  const authType = cfg.security?.auth?.selectedType;
  const defaultModelId = cfg.model?.name;
  const modelId = requestedModelId || defaultModelId;
  const baseUrl = modelId === defaultModelId ? cfg.model?.baseUrl : undefined;
  const providerProtocol = cfg.providerProtocol || {};
  const providers = Object.entries(cfg.modelProviders || {})
    .filter(([providerId]) => providerId === authType || providerProtocol[providerId] === authType)
    .flatMap(([, models]) => Array.isArray(models) ? models : []);
  const matching = providers.filter(model => model && typeof model.id === 'string' && (!modelId || model.id === modelId));
  // Match Qwen's provider lookup: prefer the paired id+baseUrl, then fall back
  // to the first matching model when that pair is absent or stale.
  const selected = (baseUrl ? matching.find(model => model.baseUrl === baseUrl) : null) || matching[0];
  const envKey = selected?.envKey || ({ openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', 'vertex-ai': 'GOOGLE_API_KEY' })[authType];
  const hasText = value => typeof value === 'string' && value.trim().length > 0;
  const key = (envKey && (hasText(cfg.env?.[envKey]) ? cfg.env[envKey].trim() : null)) ||
    (envKey && hasText(env[envKey]) ? env[envKey].trim() : null) ||
    (envKey && (qwenEnvValue(path.join(qwenDir, '.env'), envKey) || qwenEnvValue(path.join(home, '.qwen', '.env'), envKey) || qwenEnvValue(path.join(home, '.env'), envKey) || qwenProjectEnvValue(cwd, home, envKey))) ||
    (!selected?.envKey && hasText(cfg.security?.auth?.apiKey) ? cfg.security.auth.apiKey.trim() : null);
  return { authType, modelId, selected, key };
}

export function qwenAuthStatus(home = homedir(), env = process.env, requestedModelId, cwd = home) {
  const { authType, key } = qwenProviderContext(home, env, requestedModelId, cwd);
  if (key) return { status: 'unknown', auth: 'credentials_present', note: 'Qwen anahtarı yerel CLI ayarında bulundu; gerçek endpoint doğrulaması ve kota durumu ayrı gösterilir.' };
  if (authType === 'qwen-oauth') return { status: 'auth_required', auth: 'missing', note: 'Qwen OAuth artık desteklenmiyor; qwen içinde /auth ile International QwenCloud Token Plan veya API anahtarı yapılandırın.' };
  return { status: 'auth_required', auth: 'missing', note: 'Qwen için etkin sağlayıcı/anahtar bulunamadı; qwen içinde /auth ile International QwenCloud bağlantısını yapılandırın.' };
}

export async function qwenLiveAuth(home = homedir(), env = process.env, requestedModelId, cwd = home, fetcher = globalThis.fetch) {
  const { authType, modelId, selected, key } = qwenProviderContext(home, env, requestedModelId, cwd);
  if (!key) return qwenAuthStatus(home, env, requestedModelId, cwd);
  const qwenDir = env.QWEN_HOME ? path.resolve(env.QWEN_HOME) : path.join(home, '.qwen');
  const settings = readJsonSafe(path.join(qwenDir, 'settings.json'));
  const baseUrl = selected?.baseUrl || (modelId === settings.model?.name ? settings.model?.baseUrl : null);
  let apiUrl;
  try { apiUrl = new URL(baseUrl); } catch { return { status: 'unknown', auth: 'credentials_present', note: 'Qwen anahtarı kayıtlı; seçili sağlayıcının API adresi doğrulanamadı.' }; }
  const host = apiUrl.hostname.toLowerCase();
  const officialHost = host === 'token-plan.maas.qwencloudapi.com' || host === 'coding-intl.dashscope.aliyuncs.com' ||
    /^token-plan(?:\.[a-z0-9-]+)?\.maas\.aliyuncs\.com$/.test(host);
  if (apiUrl.protocol !== 'https:' || !officialHost) return { status: 'unknown', auth: 'credentials_present', note: 'Qwen anahtarı kayıtlı; bu API adresi güvenli otomatik doğrulama izin listesinde değil.' };
  try {
    const endpoint = `${apiUrl.href.replace(/\/+$/, '')}/models`;
    const response = await fetcher(endpoint, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (response.status === 200) return { status: 'unknown', auth: 'verified', note: `Qwen sağlayıcısı ${host} için API anahtarı doğrulandı; bu endpoint kota yüzdesi bildirmiyor.${modelId ? ` Model: ${modelId}.` : ''}` };
    if (response.status === 401) return { status: 'auth_required', auth: 'rejected', note: 'Qwen endpoint kayıtlı anahtarı reddetti; qwen içinde /auth ile hesabı yeniden bağlayın.' };
    return { status: 'unknown', auth: 'credentials_present', note: `Qwen API anahtarı kayıtlı; model kataloğu HTTP ${response.status} döndürdü, bu sonuç tek başına oturum hatası sayılmaz.` };
  } catch {
    return { status: 'unknown', auth: 'credentials_present', note: 'Qwen API anahtarı kayıtlı; endpoint şu anda doğrulanamadı. Ağ hatası giriş yok anlamına gelmez.' };
  }
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

  if (adapter === 'qoder') return [path.join(home, '.qoder', 'bin', 'qodercli', process.platform === 'win32' ? 'qodercli.exe' : 'qodercli')];

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

// Headless ZCode cannot choose a model per call: it runs whatever ZCode itself has
// selected. Read that selection from the CLI's own personal provider config so the
// pool reports the real plan and model instead of an invented catalogue.
export function zcodeSelection(home = homedir()) {
  const raw = readJsonSafe(path.join(home, '.zcode', 'v2', 'provider_config.json'));
  const body = raw?.config ?? raw;
  if (!body || typeof body !== 'object') return null;
  const selection = body.defaultModelSelection;
  if (typeof selection?.providerId === 'string' && typeof selection?.modelId === 'string' && selection.providerId && selection.modelId) {
    return { providerId: selection.providerId, modelId: selection.modelId };
  }
  const rules = Array.isArray(body.providerConfigRules?.providerRules) ? body.providerConfigRules.providerRules : [];
  const order = Array.isArray(body.providerOrder) ? body.providerOrder : [];
  for (const providerId of order) {
    if (typeof providerId !== 'string') continue;
    const rule = rules.find(item => item?.providerId === providerId);
    const models = rule?.config?.modelOrder ?? rule?.config?.personalModelIds ?? [];
    const modelId = models.find(item => typeof item === 'string' && item.trim());
    if (modelId) return { providerId, modelId };
  }
  return null;
}

export function assertZcodePlanSelection(route, selection) {
  if (!['token_plan', 'subscription'].includes(route.billing)) return;
  zcodePlanConfig(selection);
}

export function localModelsFor(adapter, home = homedir()) {
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
      kinds: ['mmx', 'ollama', 'lmstudio', 'omniroute'].includes(adapter) ? ['text'] : kinds,
      free,
    });
  };

  if (adapter === 'zcode') {
    // Headless ZCode cannot pick a model per call; expose exactly what it will run.
    const selection = zcodeSelection(home);
    const alias = selection
      ? `ZCode varsayılan modeli: ${selection.modelId} (${selection.providerId})`
      : 'ZCode varsayılan modeli (ZCode içinde seçilmeli)';
    add('zcode-default', alias, 'zai-plan');
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
    for (const family of ['OPUS', 'SONNET', 'HAIKU']) {
      const pinned = cfg.env?.[`ANTHROPIC_DEFAULT_${family}_MODEL`];
      if (typeof pinned === 'string' && pinned.trim()) add(pinned.trim(), pinned.trim(), 'claude', ['low', 'medium', 'high']);
    }
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
    // Only the native catalog knows which Xiaomi provider/model IDs are configured.
  } else if (adapter === 'agy') {
    // The live `models` subcommand is authoritative; never invent a local fallback.
  } else if (adapter === 'omniroute') {
    add('default', 'OmniRoute Varsayılan', 'omniroute', ['low', 'medium', 'high']);
  } else if (adapter === 'lmstudio' || adapter === 'ollama') {
    // Installed CLI alone does not prove that a local model exists; read the live catalog on refresh.
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
        minRemainingPercent: 0,
        models: [],
      };
      cloned.routes.push(route);
      addedRoutes++;
    }
    for (const model of cli.discoveredModels || []) {
      if (cli.adapter === 'claude' && ['opus', 'sonnet', 'haiku'].includes(model.id) && route.models.some(existing => existing.id.startsWith(`claude-${model.id}-`))) continue;
      if (!modelFiltered(cloned.modelFilters, route.id, model.id) && !route.models.some(existing => existing.id === model.id) && route.models.length < 100) {
        const { free, ...cleanModel } = model;
        route.models.push({ ...cleanModel, ...(free === true ? { billing: 'free' } : {}) });
        addedModels++;
      }
    }
    if (['lmstudio', 'ollama'].includes(cli.adapter)) route.models = route.models.filter(model => model.id !== 'default' || model.memberships?.length || ['high', 'medium', 'low'].includes(model.group));
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

// A WSL route runs the Linux CLI through wsl.exe --exec (no shell) with the
// account's own HOME; native routes run the Windows executable directly.
export function commandArgv(route) {
  if (route.runtime === 'wsl' && !route.api) return [...wslPrefix(route), route.executable];
  return executableArgv(route.executable);
}

export function routeCommand(route, directory = dataDirectory()) {
  return { argv: commandArgv(route), env: profileEnvironment(route, directory) };
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
  } else if (route.adapter === 'zcode') {
    const home = profileHome(route, directory);
    Object.assign(extra, zcodeEnvironment(route.executable, home));
    if (['token_plan', 'subscription'].includes(route.billing)) extra.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = zcodePlanFile(directory, zcodeSelection(home));
  } else if (route.adapter === 'opencode' || route.adapter === 'mimo') {
    const permission = taskKind === 'write'
      ? { question: 'deny', external_directory: 'deny' }
      : { bash: 'deny', edit: 'deny', write: 'deny', question: 'deny', external_directory: 'deny' };
    extra.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission });
  }
  return extra;
}

// A claude.ai subscription route skips user settings so an env redirect there cannot reroute or bill it elsewhere.
export function claudeSettingSources(route) {
  return route.api ? ['--setting-sources', 'user'] : route.billing === 'subscription' ? ['--setting-sources', 'project,local'] : [];
}

// ZCode 0.17 locates its bundled provider catalog relative to the desktop install; headless runs need it explicitly.
export function zcodeEnvironment(executable, home = homedir()) {
  const bundled = path.resolve(path.dirname(executable), '..', 'config', 'provider', 'zcode-builtin.json');
  return existsSync(bundled) ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: bundled, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(home, '.zcode', 'v2', 'provider_config.json') } : {};
}

// Pool's own stdio MCP server for director runs. The task token travels in the
// environment (inherited or forwarded), never in argv.
const poolBin = fileURLToPath(new URL('../bin/pool.js', import.meta.url));
export function poolMcpServer(context) {
  return { command: process.execPath, args: [poolBin, 'stdio'], env: { CLI_AGENT_POOL_HOME: context.directory } };
}
// Claude permission rules use //absolute paths; Windows drives become /c/...
export function claudeReadRule(directory) {
  const posix = directory.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  return `Read(/${posix}/**)`;
}
const tomlInline = values => `{${Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',')}}`;
export function codexDirectorArguments(route, context) {
  const server = poolMcpServer(context);
  return ['-c', `mcp_servers.cli-agent-pool.command=${JSON.stringify(server.command)}`,
    '-c', `mcp_servers.cli-agent-pool.args=${JSON.stringify(server.args)}`,
    '-c', `mcp_servers.cli-agent-pool.env=${tomlInline(server.env)}`,
    '-c', 'mcp_servers.cli-agent-pool.env_vars=["CLI_AGENT_POOL_TASK_TOKEN"]',
    ...(route.sandboxNetwork ? ['-c', 'sandbox_workspace_write.network_access=true'] : [])];
}

// Git transport pointers (not credentials) a director needs for push.
const gitTransportNames = ['SSH_AUTH_SOCK', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS'];
export function directorEnvironment(context) {
  const env = { CLI_AGENT_POOL_HOME: context.directory, CLI_AGENT_POOL_TASK_ID: context.taskId || '', CLI_AGENT_POOL_TASK_TOKEN: context.token || '', ...(context.secretEnv || {}) };
  for (const name of gitTransportNames) if (process.env[name]) env[name] = process.env[name];
  return env;
}

// Tool-call events (not user/system/init/result) that carry the probe markers.
export function watchEvent(context, event) {
  const watch = context?.watch;
  if (!watch) return;
  // Inspect structured native tool inputs only. Assistant prose, echoed user
  // prompts, command output and tool-result text are not invocation evidence.
  const calls = [];
  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) if (block.type === 'tool_use') calls.push({ name: block.name, input: block.input });
  } else if (['item.started', 'item.updated', 'item.completed'].includes(event.type) && event.item?.type === 'command_execution') {
    calls.push({ name: 'Bash', input: { command: event.item.command } });
  } else if (event.event === 'step_update' && event.step_update?.state !== 'ERROR') {
    const step = event.step_update;
    const tool = step.tool_info;
    if (tool || step.step_type === 'tool') calls.push({ name: tool?.name || step.tool_name, input: tool?.input || tool?.arguments || tool?.parameters || step.tool_input });
  }
  const strings = (value, depth = 0) => {
    if (typeof value === 'string') return [value];
    if (!value || typeof value !== 'object' || depth > 5) return [];
    return Object.values(value).slice(0, 100).flatMap(item => strings(item, depth + 1));
  };
  const normalized = value => { const result = value.replace(/\\/g, '/'); return process.platform === 'win32' ? result.toLowerCase() : result; };
  for (const call of calls) {
    const name = String(call.name || '').replace(/_/g, '').toLowerCase();
    const inputs = strings(call.input);
    if (['bash', 'runcommand', 'runterminalcmd'].includes(name)) {
      const text = inputs.join('\n');
      if (!text.includes(watch.scope)) continue;
      const seen = watch.markers.filter(marker => text.includes(marker));
      if (seen.length && watch.events.length < 200) watch.events.push(seen);
    } else if (['read', 'readfile', 'viewfile'].includes(name)) {
      for (const read of watch.reads || []) if (read.target && inputs.some(value => normalized(value) === normalized(read.target.file))) read.nativeRead = true;
    }
  }
}

export function buildArguments(route, model, task, context = null) {
  const directorRun = context?.profile === 'director';
  const argv = commandArgv(route);
  const effort = task.effort;
  if (Array.isArray(route.argsTemplate) && route.argsTemplate.length > 0) {
    const values = { model: model.id, effort: effort || 'default', workspace: task.workspace, prompt: task.prompt, kind: task.kind };
    const built = route.argsTemplate.map(token => token.replace(/\{(model|effort|workspace|prompt|kind)\}/g, (_, k) => String(values[k] ?? '')));
    return [...argv, ...built];
  }
  if (route.adapter === 'codex') return [...argv, '-a', 'never', ...(task.mode === 'execute' ? ['--search'] : []), 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json', '--sandbox', task.kind === 'write' ? 'workspace-write' : 'read-only', '-C', task.workspace, ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : []), '-c', 'model_provider="openai"', ...(directorRun ? codexDirectorArguments(route, context) : []), '-m', model.id, ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []), '-'];
  if (route.adapter === 'claude') return [...argv, '-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', task.kind === 'write' ? 'acceptEdits' : 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', directorRun ? JSON.stringify({ mcpServers: { 'cli-agent-pool': poolMcpServer(context) } }) : '{"mcpServers":{}}', '--disable-slash-commands', ...claudeSettingSources(route), '--tools', task.kind === 'text' ? '' : task.kind === 'read' ? 'Read,Glob,Grep' : task.mode === 'execute' ? 'default' : 'Read,Glob,Grep,Edit,Write', ...(directorRun && context.readPaths?.length ? ['--allowedTools', ...context.readPaths.map(claudeReadRule)] : []), '--model', model.id, ...(effort ? ['--effort', effort] : [])];
  if (route.adapter === 'opencode' || route.adapter === 'mimo') return [...argv, 'run', '--format', 'json', '--pure', '-m', opencodeModelId(route, model.id), '--agent', task.kind === 'write' ? 'build' : 'plan', ...(effort ? ['--variant', effort] : [])];
  // ZCode -p has no model flag: it runs the default model selected in ZCode itself.
  if (route.adapter === 'zcode') {
    if (model.id !== 'zcode-default') throw new PoolError('MODEL_UNAVAILABLE', 'ZCode headless yalnızca ZCode içinde seçilen varsayılan modeli çalıştırır. GLM/free sağlayıcısını ZCode içinde seçin; Pool modeli zcode-default olmalı.');
    return [...argv, '--cwd', task.workspace, '--mode', task.kind === 'write' ? 'edit' : 'plan', ...(task.mode === 'execute' ? [] : ['--disallowed-tools', task.kind === 'write' ? 'Bash' : 'Bash,Edit,Write']), '--json', '--no-color', '-p', task.prompt];
  }
  if (route.adapter === 'mcode') {
    if (task.kind === 'read') throw new PoolError('UNSUPPORTED_TASK_KIND', 'MiniMax Code standard modu dosya araçları sunar; smart salt okunur sınırı sağlamaz. Dosya görevleri write, araçsız yanıtlar text kullanmalı.');
    return [...argv, 'exec', '--input', '-', '--cwd', task.workspace, '--model', model.id, '--prompt-mode', 'coding', '--permission', task.kind === 'write' ? 'full' : 'smart', '--mode', task.kind === 'write' ? 'standard' : 'lightweight', '--output-format', 'stream-json', ...(effort ? ['--effort', effort] : [])];
  }
  if (route.adapter === 'kimi') return [...argv, '-m', model.id, '--output-format', 'stream-json', ...(task.kind === 'write' ? ['--auto'] : []), '-p', task.prompt];
  if (route.adapter === 'agy') {
    const selectedEffort = effort || model.defaultEffort || Object.keys(model.variants || {})[0];
    if (model.variants && !model.variants[selectedEffort]) throw new PoolError('INVALID_EFFORT', 'Bu model için desteklenen bir efor seçin.');
    const promptArg = route.promptStdin === false ? [`--print=${task.prompt}`] : ['--input-format', 'stream-json'];
    const modeArgs = task.kind === 'write' ? ['--mode', 'accept-edits'] : task.kind === 'text' ? ['--disable-slash-commands', '--settings', '{"agentMode":"plan"}'] : ['--mode', 'plan'];
    const project = route.runtime === 'wsl' ? agyProjectArguments(task.workspace, wslWindowsPath(route, wslProfileHome(route)), wslUriToWindows) : agyProjectArguments(task.workspace);
    return [...argv, ...project, '--output-format', 'stream-json', ...promptArg, ...modeArgs, ...(task.mode === 'execute' ? ['--json-schema', JSON.stringify(executionReportJsonSchema)] : []), '--model', model.variants?.[selectedEffort] || model.id, ...(selectedEffort ? ['--effort', selectedEffort] : [])];
  }
  if (route.adapter === 'omniroute') return [...argv, 'chat', '--stdin', '--no-history', '-m', model.id, ...(effort ? ['--reasoning-effort', effort] : [])];
  if (route.adapter === 'mmx') return [...argv, 'text', 'chat', '--model', model.id, '--messages-file', '-', '--output', 'json'];
  if (route.adapter === 'qwen') {
    return [...argv, '--model', model.id, '--output-format', 'stream-json', '--approval-mode', task.kind === 'write' ? 'auto-edit' : 'plan', ...(task.kind === 'text' ? ['--max-tool-calls', '0'] : [])];
  }
  if (route.adapter === 'qoder') {
    const tools = task.kind === 'text' ? '' : task.kind === 'read' ? 'Read,Glob,Grep' : task.mode === 'execute' ? 'default' : 'Read,Glob,Grep,Edit,Write';
    const grants = task.kind === 'text' ? [] : ['--allowed-tools', task.kind === 'read' ? 'Read,Glob,Grep' : task.mode === 'execute' ? 'Read,Glob,Grep,Edit,Write,Bash' : 'Read,Glob,Grep,Edit,Write'];
    return [...argv, '--cwd', task.workspace, '--tools', tools, ...grants, '-p', '--model', model.id, '--output-format', 'stream-json', '--no-session-persistence', '--max-model-request-retries', '0', '--permission-mode', task.kind === 'write' ? 'accept_edits' : 'dont_ask', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...(effort ? ['--reasoning-effort', effort] : [])];
  }
  if (route.adapter === 'ollama') return [...argv, 'run', model.id];
  if (route.adapter === 'aider') return [...argv, '--model', model.id, '--yes-always', '--no-auto-commits', '--message', task.prompt];
  throw new PoolError('UNSUPPORTED_ADAPTER', 'Bu CLI için çalıştırma şablonu (argsTemplate) tanımlanmalı.');
}

export async function checkAuth(route, cwd, python, directory = dataDirectory(), model = null) {
  if (!activeBillings.has(route.billing)) throw new PoolError('BILLING_UNCONFIRMED', 'Ödeme türü yerel ayarlarda doğrulanmalı.');
  const { argv, env } = routeCommand(route, directory);
  if (route.api) {
    if (route.api.secretRef && !hasSecret(directory, route.api.secretRef)) {
      throw new PoolError('SECRET_MISSING', `API bağlantısı (${route.id}) için anahtar kaydedilmemiş. Yönetim ekranından API anahtarını girin.`);
    }
    return;
  }
  if (route.adapter === 'codex') {
    const result = await capture([...argv, 'login', 'status'], cwd, python, env);
    if (result.code !== 0 || !/Logged in using ChatGPT/i.test(result.output + result.stderr)) throw new PoolError('AUTH_REQUIRED', `Codex CLI içinde hesabınızla giriş yapın (${route.profile ? `${route.id} bağlantısının Giriş yap düğmesi` : loginCommands.codex}).`);
  } else if (route.adapter === 'qoder') {
    const result = await capture([...argv, 'status', '-o', 'json'], cwd, python, env);
    let status;
    try { status = JSON.parse(result.output); } catch { /* Native status must be verified. */ }
    if (result.code !== 0 || status?.logged_in !== true) throw new PoolError('AUTH_REQUIRED', 'Qoder CLI içinde qodercli login ile giriş yapın; masaüstü girişi CLI oturumu sayılmaz.');
  } else if (route.adapter === 'claude') {
    if (!route.trustedSettings) throw new PoolError('SETTINGS_NOT_TRUSTED', 'Claude yerel ayarları ve hook’ları incelenerek trustedSettings etkinleştirilmeli.');
    // Inspect the same settings scope the run uses; a user-level token would otherwise mask the claude.ai login.
    const result = await capture([...argv, ...claudeSettingSources(route), 'auth', 'status', '--json'], cwd, python, env);
    let status;
    try { status = JSON.parse(result.output); } catch { /* Fail closed on CLI protocol drift. */ }
    if (result.code !== 0 || !status?.loggedIn) throw new PoolError('AUTH_REQUIRED', `Claude Code içinde giriş yapın (${route.profile ? `${route.id} bağlantısının Giriş yap düğmesi` : loginCommands.claude}).`);
    // Subscription runs skip user settings (claudeSettingSources), so a user-level endpoint redirect cannot bill elsewhere.
    if (route.billing === 'subscription' && status.authMethod !== 'claude.ai') throw new PoolError('AUTH_REQUIRED', `Claude aboneliği için claude.ai hesabıyla giriş yapın (${loginCommands.claude}) veya bağlantı ödeme türünü token_plan / paid_api olarak seçin.`);
  } else if (route.adapter === 'qwen') {
    const status = await qwenLiveAuth(profileHome(route, directory), route.profile ? {} : process.env, model?.id, cwd);
    if (status.status === 'auth_required') throw new PoolError('AUTH_REQUIRED', status.note);
  } else if (route.adapter === 'opencode' || route.adapter === 'mimo' || route.adapter === 'lmstudio' || route.adapter === 'ollama') {
    if (route.billing !== 'free' && !route.trustedSettings) throw new PoolError('SETTINGS_NOT_TRUSTED', 'Yerel CLI ayarları incelenerek trustedSettings etkinleştirilmeli.');
  } else {
    if (!route.trustedSettings) throw new PoolError('SETTINGS_NOT_TRUSTED', 'Bu bağlantının abonelik/plan ve CLI ayarları yerel olarak doğrulanmalı.');
    if (route.adapter === 'zcode') assertZcodePlanSelection(route, zcodeSelection(profileHome(route, directory)));
    if (route.adapter === 'mmx') {
      const snapshot = await quota(route, cwd, python, directory);
      if (snapshot.subscription !== 'active') {
        throw new PoolError('SUBSCRIPTION_REQUIRED', 'mmx resmi CLI erişimi için etkin MiniMax Token Plan gerekir. Günlük MiniMax Credits bakiyesi MiniMax Code (mcode) hesabı üzerinden kullanılır.');
      }
      if (snapshot.auth === 'missing') throw new PoolError('AUTH_REQUIRED', `mmx içinde giriş yapın (${loginCommands.mmx}).`);
    }
  }
}

// True once the official CLI reports a login for this account profile. Used to
// add an account route only after its sign-in succeeded. Never returns identity.
export async function accountLoggedIn(route, cwd, python, directory = dataDirectory(), read = readJsonSafe) {
  if (route.adapter === 'agy' && route.runtime === 'wsl') {
    const stored = read(wslWindowsPath(route, `${wslProfileHome(route)}/.gemini/antigravity-cli/antigravity-oauth-token`));
    const token = stored.token || stored;
    return Boolean(token?.refresh_token || token?.access_token);
  }
  const { argv, env } = routeCommand(route, directory);
  if (route.adapter === 'codex') {
    const result = await capture([...argv, 'login', 'status'], cwd, python, env);
    return result.code === 0 && /Logged in using ChatGPT/i.test(result.output + result.stderr);
  }
  if (route.adapter === 'claude') {
    const result = await capture([...argv, ...claudeSettingSources(route), 'auth', 'status', '--json'], cwd, python, env);
    try { return result.code === 0 && JSON.parse(result.output).loggedIn === true; } catch { return false; }
  }
  if (route.adapter === 'qoder') {
    const result = await capture([...argv, 'status', '-o', 'json'], cwd, python, env);
    try { return result.code === 0 && JSON.parse(result.output).logged_in === true; } catch { return false; }
  }
  if (route.adapter === 'mmx') {
    const result = await capture([...argv, 'auth', 'status', '--output', 'json'], cwd, python, env);
    try { return result.code === 0 && Boolean(JSON.parse(result.output).method); } catch { return false; }
  }
  if (route.adapter === 'mimo') {
    const result = await capture([...argv, 'providers', 'list', '--pure'], cwd, python, env);
    return result.code === 0 && Number(/(\d+)\s+credentials?/i.exec(result.output)?.[1]) > 0;
  }
  // File-based logins: only presence is checked; values are never returned.
  const home = profileHome(route, directory);
  if (route.adapter === 'zcode') return existsSync(path.join(home, '.zcode', 'v2', 'credentials.json')) || zaiKeys(home).length > 0;
  if (route.adapter === 'mcode') return Boolean(read(path.join(home, '.minimax', 'local-runtime.auth.json')).auth?.accessToken);
  if (route.adapter === 'kimi') return kimiLoggedIn(home);
  if (route.adapter === 'qwen') return qwenAuthStatus(home, {}, undefined, home).auth === 'credentials_present';
  throw new PoolError('ACCOUNT_UNSUPPORTED', 'Bu CLI için hesap girişi doğrulanamıyor.');
}

export function classifyFailure(message) {
  if (/requires? usage credits|usage credits (?:are )?(?:required|exhausted)|no (?:remaining )?usage credits/i.test(message)) return 'CREDITS_REQUIRED';
  if (/current subscription does not have access|active subscription (?:is )?required|no resource package|\b1113\b/i.test(message)) return 'SUBSCRIPTION_REQUIRED';
  if (/only.*(?:within|official)|unsupported client|client.*not allowed/i.test(message)) return 'PROVIDER_RESTRICTION';
  if (/unauthorized|not logged|login required|token expired|invalid.{0,20}(?:api.?key|token)|\b401\b/i.test(message)) return 'AUTH_REQUIRED';
  if (/rate.?limit|quota|insufficient.{0,20}(?:credit|balance)|\b429\b/i.test(message)) return 'QUOTA_EXHAUSTED';
  if (/model.{0,30}(?:not found|unavailable|not exist|not supported)|unknown model|select a model/i.test(message)) return 'MODEL_UNAVAILABLE';
  if (/workspace.{0,20}trust|permission denied/i.test(message)) return 'PERMISSION_REQUIRED';
  return 'CLI_FAILED';
}

export function parseQoderModels(output) {
  const lines = output.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.shift() !== 'MODEL' || !lines.length || lines.some(line => !/^[a-zA-Z0-9][a-zA-Z0-9_.:+/-]{0,99}$/.test(line))) {
    throw new PoolError(classifyFailure(output) === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'DISCOVERY_FAILED', 'Qoder model kataloğu alınamadı; qodercli login ve --list-models çıktısını kontrol edin.');
  }
  return [...new Set(lines)].slice(0, 100).map(id => ({ id, name: id, efforts: [], free: false }));
}

const strictJsonlAdapters = new Set(['codex', 'claude', 'qoder', 'qwen', 'opencode', 'mimo', 'agy', 'mcode']);
const promptArgAdapters = new Set(['zcode', 'kimi', 'aider']);

export function execute(route, model, task, python, progress, directory = dataDirectory(), context = null) {
  task = { ...task, prompt: taskPrompt(task, context) };
  let answer = '';
  let rawLines = [];
  let productError = false;
  let sawResult = false;
  let failureText = '';
  let permissionDenied = false;
  let permissionDetail = '';
  const argv = buildArguments(route, model, task, context);
  const extraEnv = { ...profileEnvironment(route, directory), ...routeEnvironment(route, directory, task.kind), ...(context ? directorEnvironment(context) : {}), CLI_AGENT_POOL_WORKER: '1' };
  const usesStdin = route.promptStdin ?? !promptArgAdapters.has(route.adapter);
  const input = !usesStdin ? '' : route.adapter === 'mmx' ? JSON.stringify([{ role: 'user', content: task.prompt }]) : route.adapter === 'agy' ? `${JSON.stringify({ event: 'user', message: { content: task.prompt } })}\n` : task.prompt;
  const process = runProcess({ argv, cwd: task.workspace, input, extraEnv, python, timeoutMs: task.timeoutSeconds * 1000,
    onLine(line) {
      if (!line.trim()) return;
      context?.onActivity?.();
      let event;
      try { event = JSON.parse(line); } catch {
        if (strictJsonlAdapters.has(route.adapter)) throw new Error('Invalid JSONL');
        rawLines.push(line);
        return;
      }
      watchEvent(context, event);
      if (route.adapter === 'agy' && event.event) {
        if (event.event === 'init') {
          progress('started');
          const model = event.init?.model;
          if (typeof model === 'string' && model.length <= 100 && !/[\u0000-\u001f]/.test(model)) progress('model:' + model);
        } else if (event.event === 'step_update') {
          const step = event.step_update;
          const message = step?.tool_info?.error?.message;
          if (step?.state === 'ERROR' && /permission check failed|permission denied|user.configured deny rule|user denied permission/i.test(message || '')) {
            permissionDenied = true;
            permissionDetail = redact(`${step.tool_info?.name || step.tool_name || 'native tool'}: ${message}`).slice(0, 600);
          }
        } else if (event.event === 'result') {
          const result = event.result;
          if (Array.isArray(result?.denied_actions) && result.denied_actions.length) {
            permissionDenied = true;
            permissionDetail ||= redact(`Native permission denied: ${result.denied_actions.slice(0, 5).map(action => action.display_name || action.action || 'native tool').join(', ')}. Review the CLI permission settings for this workspace.`).slice(0, 600);
          }
          sawResult = true;
          answer = typeof result?.response === 'string' ? result.response : '';
          productError ||= result?.status !== 'SUCCESS';
          if (productError) failureText = JSON.stringify(result?.error || result?.status || '');
        }
        return;
      }
      if(event.error || event.is_error)failureText=JSON.stringify(event.error || event.result || '');
      if (route.adapter === 'codex') {
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer = event.item.text || '';
        if (event.type === 'turn.completed') sawResult = true;
        if (event.type === 'turn.failed' || event.type === 'error') productError = true;
      } else if (route.adapter === 'mcode') {
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer = event.item.content || answer;
        if (event.type === 'exec.completed') {
          sawResult = true;
          productError ||= event.result?.status !== 'succeeded';
          if (event.result?.error) failureText = JSON.stringify(event.result.error);
          if (typeof event.result?.output === 'string' && event.result.output) answer = event.result.output;
          else if (task.mode === 'execute' && event.result?.output && typeof event.result.output === 'object' && !Array.isArray(event.result.output)) answer = JSON.stringify(event.result.output);
        }
        if (/.failed$/.test(event.type || '')) { productError = true; failureText = JSON.stringify(event.error || event.result?.error || ''); }
        if (event.type === 'turn.completed' && typeof event.model?.modelId === 'string') progress('model:' + event.model.modelId.slice(0, 100));
      } else if (route.adapter === 'opencode' || route.adapter === 'mimo') {
        if (event.type === 'text' && event.part?.text) answer += event.part.text;
        if (event.type === 'step_finish') sawResult = true;
        if (event.type === 'error') productError = true;
      } else {
        if (event.type === 'result') {
          if (route.adapter === 'qoder' && Array.isArray(event.permission_denials) && event.permission_denials.length) {
            permissionDenied = true;
            permissionDetail = redact(`Qoder native permission denied: ${event.permission_denials.slice(0, 5).map(item => item.tool_name || 'native tool').join(', ')}`).slice(0, 600);
          }
          answer = event.result || event.response || event.text || answer;
          productError ||= Boolean(event.is_error || event.error);
          sawResult = true;
        } else if (event.type === 'text' && (event.text || event.part?.text)) {
          answer += event.text || event.part.text;
        } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          const textPart = event.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
          if (textPart) answer = textPart;
        }
      }
      const reportedModel = event.message?.model || (['system', 'init', 'thread.started'].includes(event.type) ? event.model : null);
      if (typeof reportedModel === 'string' && reportedModel.length <= 100 && !/[\u0000-\u001f]/.test(reportedModel)) progress(`model:${reportedModel}`);
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
      } else if (route.adapter === 'zcode' && result.code === 0 && !result.stopReason) {
        try { const body = JSON.parse(result.output); answer = typeof body.response === 'string' ? body.response : ''; sawResult = Boolean(answer); } catch { productError = true; }
      } else if (!sawResult && !strictJsonlAdapters.has(route.adapter) && result.code === 0 && !result.stopReason) {
        const fallback = answer.trim() || rawLines.join('\n').trim() || result.output.trim();
        if (fallback) { answer = fallback; sawResult = true; }
      }
      // Some CLIs emit a single JSON error on stdout even on a nonzero exit.
      if (result.code !== 0 && !failureText) failureText = result.output;
      // Keep a short redacted vendor message so the calls screen can explain a failure.
      const detail = redact(`${failureText} ${result.stderr} ${sawResult ? '' : rawLines.join('\n')}`.replace(/\s+/g, ' ').trim()).slice(-600);
      const failed = error => ({ error, ...(detail ? { detail } : {}) });
      if (result.stopReason) return failed(result.stopReason);
      if (permissionDenied) return { error: 'PERMISSION_REQUIRED', detail: permissionDetail || 'Native tool permission denied.', ...(answer.trim() ? { result: redact(answer) } : {}) };
      if (result.code !== 0 || productError) return failed(classifyFailure(`${failureText} ${result.stderr} ${rawLines.join('\n')}`));
      if (!sawResult || !answer.trim()) return failed('INVALID_RESULT');
      if (route.adapter === 'mcode' && task.mode === 'execute') {
        // MiniMax may introduce its final report with prose. Accept only one
        // trailing JSON fence containing an otherwise fully valid report.
        // Native failures above remain failures, and invalid reports stay raw.
        const delimiters = [...answer.matchAll(/`{3,}/g)];
        const fence = answer.match(/(?:^|\r?\n)```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/);
        if (delimiters.length === 2 && delimiters.every(item => item[0] === '```') && fence) {
          const report = parseExecutionReport(fence[1]);
          if (report) answer = JSON.stringify(report);
        }
      }
      return { result: redact(answer) };
    }),
  };
}

export async function opencodeCatalog(route, cwd, python, directory = dataDirectory()) {
  const command = routeCommand(route, directory);
  const argv = [...command.argv, 'models', '--verbose', '--pure'];
  const result = await runProcess({ argv, cwd, python, extraEnv: command.env, timeoutMs: 25_000, maxBytes: 16_777_216 }).done;
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
      if (!free && (route.billing === 'free' || provider === 'openrouter' && route.billing !== 'paid_api')) continue;
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
  // Keep zero-cost options visible even when large provider catalogs exceed the
  // route limit; otherwise free OpenRouter models near the end stay mislabeled
  // as paid_api and never become eligible for the free pool.
  const prioritized = [...models.filter(model => model.free), ...models.filter(model => !model.free)];
  return { connection: route.id, models: prioritized.slice(0, 100), nextCursor: null };
}

export async function claudeCatalog(route, cwd, python, directory = dataDirectory()) {
  let response;
  const command = routeCommand(route, directory);
  const handle = runProcess({ extraEnv: command.env, argv: [...command.argv, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}', ...claudeSettingSources(route)], cwd, python, relay: true, timeoutMs: 20_000,
    onLine(line) {
      const message = JSON.parse(line);
      if (message.type === 'control_response' && message.response?.request_id === 'pool-catalog') {
        response = message.response;
        handle.cancel('CONTROL_COMPLETE');
      }
    },
  });
  handle.send(JSON.stringify({ type: 'control_request', request_id: 'pool-catalog', request: { subtype: 'initialize', hooks: {} } }) + '\n');
  await handle.done;
  if (!Array.isArray(response?.response?.models)) throw new PoolError('DISCOVERY_FAILED', 'Claude model kataloğu alınamadı. CLI sürümünü ve giriş durumunu kontrol edin.');
  const models = [];
  for (const row of response.response.models) {
    const id = row.resolvedModel || row.value;
    if (typeof id !== 'string' || !id || id.length > 100 || /[\u0000-\u001f]/.test(id)) continue;
    const existing = models.find(model => model.id === id);
    if (existing) { if (row.value) existing.aliases.push(row.value); continue; }
    models.push({ id, name: id, aliases: [row.value].filter(Boolean), efforts: (row.supportedEffortLevels || []).filter(value => typeof value === 'string').slice(0, 10), free: false });
  }
  return { connection: route.id, models: models.slice(0, 100), nextCursor: null };
}

export function mergeCatalogModels(route, catalog, filters = []) {
  const staged = structuredClone(route);
  const nextFilters=structuredClone(filters);
  for(const item of catalog.models) if(item.variants) for(const rule of nextFilters) if(rule.match==='model' && (!rule.routeId || rule.routeId===route.id) && item.aliases?.includes(rule.value)) rule.value=item.id;
  const added = mergeCatalogModelsInto(staged, catalog, nextFilters);
  route.models = staged.models;
  filters.splice(0,filters.length,...nextFilters);
  return added;
}

function mergeCatalogModelsInto(route, catalog, filters) {
  let added = 0;
  if (route.adapter === 'opencode') {
    const catalogModels = new Map(catalog.models.map(model => [model.id, model]));
    for (const model of route.models) {
      const item = catalogModels.get(model.id);
      if (item?.free === true) model.billing = 'free';
      else if (model.billing === 'free') delete model.billing;
    }
  }
  if(route.adapter==='mimo' || route.adapter==='opencode' && route.billing==='free') {
    const available=new Set(catalog.models.map(model=>model.id));
    for(const model of route.models) if(!available.has(model.id))model.enabled=false;
  }
  if (route.adapter === 'agy') {
    for (const model of route.models) if (['gemini-2.5-pro','gemini-2.5-flash','gemini-3-flash'].includes(model.id) && !catalog.models.some(item => item.id === model.id)) model.enabled = false;
    route.models = route.models.filter(model => !['gemini-2.5-pro','gemini-2.5-flash','gemini-3-flash'].includes(model.id) || catalog.models.some(item => item.id === model.id) || model.memberships?.length || ['high','medium','low'].includes(model.group));
  }
  for (const item of catalog.models) {
    if (modelFiltered(filters, route.id, item.id) && (!item.variants || !route.models.some(model=>model.id===item.id || item.aliases?.includes(model.id)))) continue;
    if (item.variants) {
      const previous = route.models.filter(model => model.id === item.id || item.aliases?.includes(model.id));
      if (previous.length) {
        const merged = structuredClone(previous.find(model => model.id === item.id) || previous[0]);
        const members = new Map();
        for (const model of previous) {
          const inferredEffort = Object.entries(item.variants).find(([,id]) => id === model.id)?.[0];
          for (const member of model.memberships ?? (['high','medium','low'].includes(model.group) ? [{group:model.group,effort:model.defaultEffort}] : [])) {
            const value = {...member, ...(member.effort || inferredEffort ? {effort:member.effort || inferredEffort} : {})};
            if (members.has(value.group) && members.get(value.group).effort !== value.effort) throw new PoolError('MODEL_VARIANT_CONFLICT', `${item.id}: aynı havuzdaki eski varyantların eforları çakışıyor. Önce üyelikleri düzenleyin.`);
            if (value.effort && !item.efforts.includes(value.effort)) throw new PoolError('CATALOG_EFFORT_CHANGED', 'Kayıtlı havuz eforu yeni katalogda yok.');
            members.set(value.group,value);
          }
        }
        Object.assign(merged,{id:item.id,alias:item.name || item.id,variants:item.variants,efforts:item.efforts,memberships:[...members.values()],enabled:previous.some(model=>model.enabled!==false)});
        if (merged.defaultEffort && !item.efforts.includes(merged.defaultEffort)) delete merged.defaultEffort;
        route.models = route.models.filter(model=>!previous.includes(model)); route.models.push(merged);
        continue;
      }
    }
    const existing = route.models.find(model => model.id === item.id) || route.models.find(model => item.aliases?.includes(model.id));
    if (existing) {
      if (existing.memberships?.some(member => member.effort && !item.efforts.includes(member.effort))) throw new PoolError('CATALOG_EFFORT_CHANGED', 'Katalogda havuz eforu artık desteklenmiyor. Önce o modelin havuz eforunu düzenleyin.');
      existing.id = item.id;
      existing.alias = (item.name || item.id).slice(0, 100);
      existing.efforts = item.efforts;
      if (item.variants) existing.variants = item.variants;
      if (!item.efforts.includes(existing.defaultEffort)) delete existing.defaultEffort;
    } else if (route.models.length < 100) {
      route.models.push({ id: item.id, alias: (item.name || item.id).slice(0, 100), group: 'unassigned', memberships: [], enabled: true, efforts: item.efforts, ...(route.adapter === 'opencode' && item.free === true ? { billing: 'free' } : {}), ...(item.variants?{variants:item.variants}:{}), kinds: ['mmx', 'ollama', 'lmstudio', 'omniroute'].includes(route.adapter) ? ['text'] : ['text', 'read', 'write'] });
      added++;
    }
  }
  if (route.adapter === 'zcode') {
    // Headless ZCode runs exactly one model. Older catalogues listed provider
    // identities such as `builtin:zai-coding-plan/GLM-5.3` that the CLI cannot
    // select, so they are retired and their pool membership moves to the model
    // that really runs.
    const runnable = route.models.find(model => model.id === 'zcode-default');
    const stale = route.models.filter(model => model.id !== 'zcode-default');
    for (const model of stale) model.enabled = false;
    if (runnable && stale.length) {
      const members = new Map();
      for (const model of [...stale, runnable]) {
        const list = model.memberships ?? (['high','medium','low'].includes(model.group) ? [{group:model.group, ...(model.defaultEffort?{effort:model.defaultEffort}:{})}] : []);
        for (const member of list) if (!members.has(member.group)) members.set(member.group, { ...member });
      }
      if (members.size) {
        runnable.memberships = [...members.values()];
        runnable.group = runnable.memberships[0].group;
      }
    }
  }
  return added;
}

export async function routeCatalog(route, cwd, python, directory = dataDirectory()) {
  if (route.adapter === 'qoder') {
    const command = routeCommand(route, directory);
    const result = await capture([...command.argv, '--list-models'], cwd, python, command.env);
    if (result.code !== 0) throw new PoolError(classifyFailure(result.output + result.stderr), 'Qoder native model listesi alınamadı; CLI girişini kontrol edin.');
    return { connection: route.id, models: parseQoderModels(result.output), nextCursor: null };
  }
  if (route.adapter === 'agy' && !route.api) {
    const command = routeCommand(route, directory);
    const result = await capture([...command.argv, 'models'], cwd, python, command.env, route.runtime === 'wsl' ? 45_000 : 15_000);
    if (result.code !== 0 || result.stopReason) throw new PoolError(/sign in/i.test(result.output + result.stderr) ? 'AUTH_REQUIRED' : 'DISCOVERY_FAILED', `Antigravity model listesi alınamadı. ${route.runtime === 'wsl' ? `${route.id} bağlantısında Giriş yap ile bu hesaba giriş yapın.` : 'CLI giriş durumunu kontrol edin.'}`);
    const models = result.output.split(/\r?\n/).flatMap(line => {
      const match = line.match(/^([a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99})\t+(.+)$/);
      if (!match) return [];
      const effort = match[1].match(/-(low|medium|high|xhigh|max)$/)?.[1];
      return [{ id: match[1], name: match[2].trim().slice(0,100), efforts: effort ? [effort] : [], free: false }];
    });
    if (!models.length) throw new PoolError('DISCOVERY_FAILED', 'Antigravity model listesi boş veya biçimi tanınmadı.');
    const grouped = new Map();
    for (const model of models) {
      const effort=model.efforts[0], id=effort?model.id.slice(0,-effort.length-1):model.id;
      const entry=grouped.get(id) || {id,name:id,efforts:[],free:false,...(effort?{variants:{},aliases:[]}: {})};
      if(effort){entry.efforts.push(effort);entry.variants[effort]=model.id;entry.aliases.push(model.id);}
      grouped.set(id,entry);
    }
    return { connection: route.id, models: [...grouped.values()].slice(0,100), nextCursor: null };
  }
  if (route.adapter === 'claude' && !route.api) return claudeCatalog(route, cwd, python, directory);
  if (['lmstudio', 'ollama'].includes(route.adapter)) {
    const result = await capture([...executableArgv(route.executable), ...(route.adapter === 'lmstudio' ? ['ls', '--json'] : ['list'])], cwd, python);
    if (result.code !== 0) throw new PoolError('DISCOVERY_FAILED', `${route.adapter === 'lmstudio' ? 'LM Studio' : 'Ollama'} model kataloğu alınamadı. Yerel uygulamanın kurulu ve çalışıyor olduğunu kontrol edin.`);
    let entries;
    if (route.adapter === 'lmstudio') {
      let parsed;
      try { parsed = JSON.parse(result.output); } catch { throw new PoolError('DISCOVERY_FAILED', 'LM Studio katalog biçimi tanınmadı.'); }
      entries = Array.isArray(parsed) ? parsed : parsed.models;
      if (!Array.isArray(entries)) throw new PoolError('DISCOVERY_FAILED', 'LM Studio model listesi tanınmadı.');
      entries = entries.map(model => ({ id: model.modelKey || model.key || model.id, name: model.modelKey || model.key || model.id }));
    } else entries = result.output.trim().split(/\r?\n/).slice(1).map(line => { const [id, digest] = line.trim().split(/\s+/); return { id, name: `${id} · ${digest}` }; });
    return { connection: route.id, models: entries.filter(model => typeof model.id === 'string' && model.id && model.id.length <= 100).slice(0, 100).map(model => ({ ...model, efforts: [], free: true })), nextCursor: null };
  }
  if (route.adapter === 'opencode' || route.adapter === 'mimo') {
    try {
      const live = await opencodeCatalog(route, cwd, python, directory);
      const local = localModelsFor(route.adapter, profileHome(route, directory)).filter(m => route.billing !== 'free' || m.free);
      const merged = [...live.models];
      for (const item of local) {
        if (!merged.some(m => m.id === item.id)) {
          merged.push({ id: item.id, name: item.alias, free: Boolean(item.free), efforts: item.efforts || [], defaultEffort: null });
        }
      }
      return { connection: route.id, models: merged.slice(0, 100), nextCursor: null };
    } catch {
      const fallback = localModelsFor(route.adapter, profileHome(route, directory));
      return { connection: route.id, models: fallback.map(m => ({ id: m.id, name: m.alias, free: Boolean(m.free), efforts: m.efforts || [], defaultEffort: null })), nextCursor: null };
    }
  }
  const discovered = localModelsFor(route.adapter, profileHome(route, directory));
  return {
    connection: route.id,
    models: discovered.map(m => ({ id: m.id, name: m.alias, free: Boolean(m.free), efforts: m.efforts || [], defaultEffort: null })),
    nextCursor: null,
  };
}

const nativeQuota = { claude: claudeQuota, zcode: zaiQuota, agy: antigravityQuota, kimi: kimiQuota, mcode: minimaxQuota };

export async function quota(route, cwd, python, directory = dataDirectory()) {
  const observedAt = new Date().toISOString();
  const base = { connection: route.id, adapter: route.adapter, billing: route.billing, loginCommand: loginCommands[route.adapter], observedAt };
  if (route.api) {
    const configured = !route.api.secretRef || hasSecret(directory, route.api.secretRef);
    const fallback = { ...base, status: configured ? 'available' : 'auth_required', auth: configured ? 'api_key' : 'missing', endpoint: route.api.baseUrl, protocol: route.api.protocol, windows: [], source: 'custom-api' };
    const vendor = configured && route.api.secretRef ? await apiRouteQuota(route.api.baseUrl, loadSecret(directory, route.api.secretRef)) : null;
    return vendor ? { ...fallback, ...vendor, auth: 'api_key' } : fallback;
  }
  const { argv, env } = routeCommand(route, directory);
  if (route.adapter === 'agy' && route.runtime === 'wsl') {
    // agy keeps a WSL login as a file under the profile HOME; read it in memory only.
    const tokenFile = wslWindowsPath(route, `${wslProfileHome(route)}/.gemini/antigravity-cli/antigravity-oauth-token`);
    return { ...base, account: route.profile || 'default', ...(await antigravityQuota(undefined, { tokenFile, credentialStore: false })) };
  }
  if (route.adapter === 'claude' && route.billing === 'subscription' && route.profile) {
    return { ...base, account: route.profile, ...(await claudeQuota(undefined, claudeConfigDirectory(route, directory))) };
  }
  if (route.adapter === 'qoder') {
    const result = await capture([...argv, 'status', '-o', 'json'], cwd, python, env);
    let status;
    try { status = JSON.parse(result.output); } catch { /* Never persist account identifiers. */ }
    const loggedIn = result.code === 0 && status?.logged_in === true;
    return { ...base, status: loggedIn ? 'unknown' : 'auth_required', auth: loggedIn ? 'verified' : 'missing', windows: [], source: 'qoder-status', note: 'Qoder native login doğrulanır; kalan account credits bu komutta bildirilmez.' };
  }
  if (route.adapter === 'claude' && route.billing !== 'subscription') {
    // Token-plan Claude routes use the user's configured endpoint; claude.ai usage does not apply.
    const text = await capture([...argv, 'auth', 'status', '--text'], cwd, python, env);
    const endpoint = /base URL:\s*(\S+)/i.exec(text.output + text.stderr)?.[1] || 'https://api.anthropic.com';
    return { ...base, status: 'unknown', auth: 'token_plan', endpoint, windows: [], source: 'claude-settings', note: `Uç nokta: ${endpoint} · Bu sağlayıcı kota yüzdesi bildirmiyor.` };
  }
  if (route.adapter === 'qwen') {
    const auth = await qwenLiveAuth(profileHome(route, directory), route.profile ? {} : process.env, undefined, cwd);
    // A route contains multiple model/provider credentials. Only checkAuth for
    // the selected model may reject a task; the default model cannot log out
    // every other provider in the route.
    return { ...base, ...auth, status: auth.status === 'auth_required' ? 'unknown' : auth.status, windows: [], source: 'qwen-model-list' };
  }
  if (nativeQuota[route.adapter]) {
    const snapshot = await nativeQuota[route.adapter](profileHome(route, directory));
    if (route.adapter === 'mcode' && route.billing === 'free_credits' && snapshot.subscription === 'none') {
      return { ...base, ...snapshot, note: 'MiniMax Coding Plan kotası yok. Bu sorgu MiniMax Credits bakiyesini göstermez; MiniMax Code CLI mevcut hesap kredileriyle yine de çalışabilir.' };
    }
    return { ...base, ...snapshot };
  }
  if (route.adapter === 'opencode' || route.adapter === 'mimo') {
    let snapshot = { status: 'unknown', auth: 'unverified', windows: [], source: route.adapter };
    try {
      const result = await capture([...argv, 'providers', 'list', '--pure'], cwd, python, env);
      const count = /(\d+)\s+credentials?/i.exec(result.output)?.[1];
      if (result.code === 0 && count !== undefined) snapshot = { status: Number(count) === 0 && route.billing !== 'free' ? 'auth_required' : 'unknown', auth: Number(count) > 0 ? 'credentials_present' : 'unverified', windows: [], source: 'native-provider-list' };
    } catch { /* A failed inspection is not proof that the user is logged out. */ }
    if (route.adapter === 'opencode' && route.models.some(model => model.id.startsWith('openrouter/'))) {
      const openrouter = await openrouterQuota();
      if (openrouter) snapshot = { ...snapshot, ...openrouter, auth: openrouter.auth === 'missing' ? snapshot.auth : 'credentials_present', status: snapshot.status === 'unknown' ? 'available' : snapshot.status };
    }
    return { ...base, ...snapshot };
  }
  if (route.adapter === 'lmstudio' || route.adapter === 'ollama') {
    return { ...base, status: 'available', auth: route.billing === 'free' ? 'builtin_free' : 'configured', windows: [], source: route.adapter };
  }
  if (route.adapter !== 'mmx') return { ...base, status: 'unknown', auth: 'unverified', windows: [], source: route.adapter, note: 'Bu CLI kota sorgusu sunmuyor.' };
  const authRes = await capture([...argv, 'auth', 'status', '--output', 'json'], cwd, python, env);
  let authJson = {};
  try { authJson = JSON.parse(authRes.output); } catch {}
  const loggedIn = authRes.code === 0 && Boolean(authJson?.method);
  const result = await capture([...argv, 'quota', 'show', '--output', 'json'], cwd, python, env);
  let body;
  try { body = JSON.parse(result.output); } catch { /* Unknown output never proves an active plan. */ }
  const failure = result.code !== 0 || !body || body.error || body.base_resp?.status_code;
  const subscription = !failure ? 'active' : /no active (?:token )?plan/i.test(result.output + result.stderr) ? 'none' : 'unknown';
  const windows = failure ? [] : minimaxWindows(body.data || body);
  const status = !loggedIn ? 'auth_required' : windows.some(window => window.remainingPercent <= 0) ? 'rate_limited' : subscription === 'active' ? 'available' : 'unknown';
  return { ...base, status, auth: loggedIn ? authJson.method : 'missing', subscription, windows, source: 'mmx' };
}
