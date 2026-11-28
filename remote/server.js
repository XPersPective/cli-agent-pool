import http from 'node:http';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { allowedWorkspace, configView, dataDirectory, PoolError } from '../src/config.js';
import { ensureDaemon, ensureInitialized, managementRequest, scheduleServiceRestart } from '../src/daemon.js';
import { pickWindowsFolder } from '../src/web.js';
import { quotaApplies, cleanModelDisplayName, sortEfforts } from '../web/pool-state.js';
import { version } from '../src/version.js';
import { qrSvg } from './qr.js';
import { buildCompactPrompt, RemoteStore } from './store.js';

const execFileAsync = promisify(execFile);
const publicDir = fileURLToPath(new URL('./public', import.meta.url));
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'needs_review']);
const SKIP_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git', '.hg', '.svn']);

export function findTailscaleExecutable() {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe'),
    ];
    for (const c of candidates) {
      try { if (existsSync(c)) return c; } catch { /* ignore */ }
    }
  }
  return 'tailscale';
}

export async function detectTailscaleHttpsUrl(port = 43128, { run = execFileAsync } = {}) {
  try {
    const exe = findTailscaleExecutable();
    const { stdout } = await run(exe, ['serve', 'status', '--json'], { timeout: 2500, windowsHide: true, maxBuffer: 65_536 });
    const clean = String(stdout || '').replace(/^\uFEFF/, '').trim();
    if (!clean || !clean.startsWith('{')) return null;
    const data = JSON.parse(clean);
    const web = data?.Web || {};
    const targetRe = new RegExp(`^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost):${Number(port)}\\/?$`, 'i');
    for (const [hostPort, entry] of Object.entries(web)) {
      const handlers = entry?.Handlers || {};
      const matched = Object.values(handlers).some(h => targetRe.test(String(h?.Proxy || '')));
      if (matched) {
        const hostOnly = String(hostPort).replace(/:443$/, '');
        if (/^[a-z0-9.-]+(?::\d+)?$/i.test(hostOnly)) return `https://${hostOnly}`;
      }
    }
  } catch { /* tailscale serve not active or CLI absent */ }
  return null;
}

export async function enableTailscaleHttps(port = 43128, { run = execFileAsync } = {}) {
  const exe = findTailscaleExecutable();
  try {
    await run(exe, ['serve', '--bg', String(port)], { timeout: 12_000, windowsHide: true, maxBuffer: 65_536 });
  } catch (err) {
    throw new PoolError('TAILSCALE_HTTPS_FAILED', `Tailscale HTTPS tüneli açılamadı: ${err?.stderr || err?.message || 'tailscale serve başarısız'}`.slice(0, 300));
  }
  const url = await detectTailscaleHttpsUrl(port, { run });
  if (!url) throw new PoolError('TAILSCALE_HTTPS_FAILED', 'Tailscale HTTPS tüneli başlatıldı ancak adres okunamadı.');
  return url;
}

export function detectTailscaleIp(ifaces = networkInterfaces()) {
  for (const entries of Object.values(ifaces || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || entry.family !== 'IPv4') continue;
      const parts = String(entry.address || '').split('.').map(Number);
      if (parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) {
        return entry.address;
      }
    }
  }
  return null;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function pathWithinRoot(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function isSensitiveSystemPath(targetPath, dataDir) {
  const sensitive = [];
  if (dataDir) sensitive.push(dataDir);
  const home = homedir();
  for (const sub of ['.ssh', '.aws', '.gnupg', path.join('.config', 'gh')]) {
    sensitive.push(path.join(home, sub));
  }
  for (const raw of sensitive) {
    try {
      const real = realpathSync(raw);
      if (pathWithinRoot(targetPath, real)) return true;
    } catch {
      const resolved = path.resolve(raw);
      if (pathWithinRoot(targetPath, resolved)) return true;
    }
  }
  return false;
}

function canonicalRoots(workspaceRoots = []) {
  const roots = [];
  for (const raw of workspaceRoots || []) {
    try {
      const real = realpathSync(raw);
      if (statSync(real).isDirectory() && !roots.includes(real)) roots.push(real);
    } catch { /* ignore nonexistent root */ }
  }
  return roots;
}

export function listDirectoriesSafe(requestedPath = '', workspaceRoots = []) {
  const allowedRoots = canonicalRoots(workspaceRoots);
  if (!requestedPath) {
    if (allowedRoots.length) {
      return {
        current: '',
        parent: '',
        restricted: true,
        entries: allowedRoots.map(p => ({
          name: path.basename(p) || p,
          path: p,
          isGit: existsSync(path.join(p, '.git')),
        })),
      };
    }
    const defaults = [];
    const winDrives = [];
    if (process.platform === 'win32') {
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const drive = `${letter}:\\`;
        try { if (existsSync(drive)) winDrives.push(drive); } catch { /* skip */ }
      }
    }
    const candidates = [
      ...(process.platform === 'win32' ? winDrives : ['/']),
      homedir(),
    ];
    for (const c of candidates) {
      try {
        const real = realpathSync(c);
        if (statSync(real).isDirectory() && !defaults.includes(real)) defaults.push(real);
      } catch { /* skip unreadable drive/dir */ }
    }
    return {
      current: '',
      parent: '',
      restricted: false,
      entries: defaults.map(p => ({
        name: p,
        path: p,
        isGit: existsSync(path.join(p, '.git')),
      })),
    };
  }

  let real;
  try {
    real = realpathSync(requestedPath);
  } catch {
    throw new PoolError('INVALID_WORKSPACE', 'Klasör bulunamadı veya okunamıyor.');
  }
  if (!statSync(real).isDirectory()) throw new PoolError('INVALID_WORKSPACE', 'Seçilen yol bir klasör değil.');
  if (allowedRoots.length && !allowedRoots.some(root => pathWithinRoot(real, root))) {
    throw new PoolError('WORKSPACE_DENIED', 'Bu klasör izinli çalışma alanı köklerinin dışında.');
  }

  const entries = [];
  try {
    for (const dirent of readdirSync(real, { withFileTypes: true })) {
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(dirent.name) || dirent.name.startsWith('.')) continue;
      const full = path.join(real, dirent.name);
      try {
        const target = realpathSync(full);
        if (!statSync(target).isDirectory()) continue;
        if (allowedRoots.length && !allowedRoots.some(root => pathWithinRoot(target, root))) continue;
        entries.push({
          name: dirent.name,
          path: target,
          isGit: existsSync(path.join(target, '.git')),
        });
      } catch { /* skip unreadable symlink/folder */ }
      if (entries.length >= 200) break;
    }
  } catch {
    throw new PoolError('INVALID_WORKSPACE', 'Klasör içeriği okunamadı.');
  }
  entries.sort((a, b) => Number(b.isGit) - Number(a.isGit) || a.name.localeCompare(b.name, 'tr'));

  const up = path.dirname(real);
  let parent = '';
  if (up && up !== real) {
    if (!allowedRoots.length || allowedRoots.some(root => pathWithinRoot(up, root))) parent = up;
  }
  return { current: real, parent, restricted: allowedRoots.length > 0, entries };
}

const TOOL_LABELS = {
  codex: 'Codex',
  claude: 'Claude',
  agy: 'Antigravity',
  opencode: 'OpenCode',
  qwen: 'Qwen',
  zcode: 'ZCode',
  mcode: 'MiniMax',
  mmx: 'MiniMax',
  kimi: 'Kimi',
  mimo: 'MiMo',
  qoder: 'Qoder',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  omniroute: 'OmniRoute',
};

function toolLabelFor(adapter = '') {
  return TOOL_LABELS[String(adapter || '').toLowerCase()] || (adapter ? String(adapter) : '');
}

function shortWindowLabel(name = '') {
  const lower = String(name || '').toLowerCase();
  if (/5\s*h|5\s*s|300m|session|five.?hour/.test(lower)) return '5s';
  if (/week|7\s*d|7\s*g|10080m|hafta/.test(lower)) return '7g';
  if (/day|daily|24\s*h|gün/.test(lower)) return '24s';
  if (/month|30\s*d|ay/.test(lower)) return '30g';
  const tail = String(name || '').split(':').pop()?.trim() || '';
  return tail.slice(0, 8) || 'kota';
}

function enrichModel(model, routeWindowsByRoute, routeMetaByRoute = new Map()) {
  const cleanEfforts = sortEfforts(model.efforts);
  const cleanEffort = model.effort && model.effort !== 'default' ? model.effort : '';
  const cleanName = cleanModelDisplayName(model.modelId || model.id, model.name || model.alias);
  const routeWins = routeWindowsByRoute.get(model.routeId) || [];
  const applicable = routeWins.filter(w => quotaApplies(w, model.modelId || model.id) && Number.isFinite(w.remainingPercent));
  const byLabel = new Map();
  for (const w of applicable) {
    const label = shortWindowLabel(w.name);
    const prev = byLabel.get(label);
    if (!prev || w.remainingPercent < prev.remainingPercent) {
      byLabel.set(label, { label, name: w.name, remainingPercent: Math.round(w.remainingPercent), resetsAt: w.resetsAt ?? null });
    }
  }
  const order = { '5s': 0, '24s': 1, '7g': 2, '30g': 3 };
  const quotaWindows = [...byLabel.values()].sort((a, b) => (order[a.label] ?? 9) - (order[b.label] ?? 9));
  const meta = routeMetaByRoute.get(model.routeId) || {};
  const adapter = model.adapter || meta.adapter || '';
  return {
    ...model,
    name: cleanName,
    adapter,
    toolLabel: toolLabelFor(adapter),
    email: model.email || meta.email || '',
    account: model.account || meta.account || '',
    billing: model.billing || meta.billing || '',
    quotaStatus: meta.quotaStatus || model.quota?.status || '',
    effort: cleanEffort,
    efforts: cleanEfforts,
    quotaWindows,
  };
}

function sortModelsAlpha(list = []) {
  return [...list].sort((a, b) => String(a.name || a.modelId || '').localeCompare(String(b.name || b.modelId || ''), 'tr', { sensitivity: 'base' }));
}

async function readJsonBody(req, limitBytes = Infinity) {
  const ct = String(req.headers['content-type'] || '');
  if (!/^application\/json(?:\s*;|$)/i.test(ct)) {
    throw new PoolError('CONTENT_TYPE', 'application/json Content-Type başlığı gerekli.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (Number.isFinite(limitBytes) && size > limitBytes) {
      req.resume();
      throw new PoolError('REQUEST_TOO_LARGE', 'İstek boyutu sınırı aşıldı.');
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new PoolError('INVALID_JSON', 'Geçerli JSON gövdesi gerekli.'); }
}

function createPoolBridge(directory, customFetch = fetch) {
  const getConfig = () => {
    try { return configView(directory).config; } catch { return ensureInitialized(directory, false); }
  };
  const accessToken = () => {
    const file = path.join(directory, 'access-token');
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  };
  const requestPool = async (routePath, { method = 'GET', body, auth = true, timeoutMs = 0 } = {}) => {
    const cfg = getConfig();
    const headers = {};
    if (auth) {
      const tok = accessToken();
      if (tok) headers.Authorization = `Bearer ${tok}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await customFetch(`http://127.0.0.1:${cfg.port}${routePath}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new PoolError(data?.error?.code || 'POOL_API_ERROR', data?.error?.message || `Pool API hatası (${res.status}).`);
    }
    return data;
  };
  return {
    getConfig,
    health: async () => {
      try { return await requestPool('/api/health', { auth: false, timeoutMs: 2500 }); }
      catch { return { status: 'stopped', version: null, connections: 0, models: 0, active: 0 }; }
    },
    pools: () => requestPool('/api/pools?limit=40', { auth: true }),
    poolModels: async group => {
      const models = [];
      let offset = 0;
      let last = null;
      for (let page = 0; page < 15; page++) {
        const res = await requestPool(`/api/pools/${encodeURIComponent(group)}?limit=40&offset=${offset}`, { auth: true });
        last = res;
        if (Array.isArray(res.models)) models.push(...res.models);
        if (res.nextOffset == null || !res.models?.length) break;
        offset = res.nextOffset;
      }
      return { ...(last || {}), models };
    },
    catalogModels: async () => {
      try {
        return await managementRequest(directory, getConfig(), { operation: 'catalog_models' }, { timeoutMs: 10_000 });
      } catch (error) {
        if (!(error instanceof PoolError) || error.code !== 'INVALID_OPERATION') throw error;
      }
      const all = [];
      let offset = 0;
      for (let page = 0; page < 15; page++) {
        const res = await requestPool(`/api/catalog?view=models&limit=40&offset=${offset}`, { auth: true });
        if (Array.isArray(res.models)) all.push(...res.models);
        if (res.nextOffset == null || !res.models?.length) break;
        offset = res.nextOffset;
      }
      return all;
    },
    quotas: () => requestPool('/api/quotas', { auth: true }),
    routeQuota: routeId => requestPool(`/api/quotas/${encodeURIComponent(routeId)}`, { auth: true }),
    liveQuota: routeId => requestPool(`/api/quotas/${encodeURIComponent(routeId)}?live=1`, { auth: true }),
    connections: () => requestPool('/api/connections', { auth: true }),
    tasks: (limit = 50) => requestPool(`/api/tasks?limit=${limit}&activeFirst=1`, { auth: true }),
    task: (id, compact = false) => requestPool(`/api/tasks/${encodeURIComponent(id)}?compact=${compact ? '1' : '0'}`, { auth: true }),
    submit: payload => requestPool('/api/tasks', { method: 'POST', body: payload, auth: true }),
    cancel: id => requestPool(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {}, auth: true }),
    manageGet: () => managementRequest(directory, getConfig(), { operation: 'get' }),
    manageSave: (config, revision) => managementRequest(directory, getConfig(), { operation: 'save', config, revision }, { timeoutMs: 10_000 }),
    clearHistory: () => managementRequest(directory, getConfig(), { operation: 'clear_history' }, { timeoutMs: 10_000 }),
    deleteTask: taskId => managementRequest(directory, getConfig(), { operation: 'delete_task', taskId }, { timeoutMs: 10_000 }),
    resolveTask: (taskId, note = 'Remote arayüzünden incelenerek kapatıldı.') => managementRequest(directory, getConfig(), { operation: 'resolve', taskId, reviewed: true, note }, { timeoutMs: 10_000 }),
    refreshRouteAuth: routeId => managementRequest(directory, getConfig(), { operation: 'refresh_route_auth', routeId }, { timeoutMs: 30_000 }),
    loginRoute: routeId => managementRequest(directory, getConfig(), { operation: 'login_route', routeId }, { timeoutMs: 25_000 }),
    startPool: async () => {
      const cfg = ensureInitialized(directory, true);
      const info = await ensureDaemon(directory, cfg);
      return { started: true, endpoint: info.endpoint, health: await requestPool('/api/health', { auth: false, timeoutMs: 4000 }).catch(() => null) };
    },
    stopPool: async (force = false) => {
      const cfg = getConfig();
      return managementRequest(directory, cfg, { operation: 'shutdown', force: Boolean(force) });
    },
    restartPool: async () => {
      const cfg = getConfig();
      const health = await requestPool('/api/health', { auth: false, timeoutMs: 2500 }).catch(() => null);
      if (health?.active > 0) {
        return { restarted: false, confirmRequired: true, activeCount: health.active, message: `Şu anda ${health.active} aktif görev çalışıyor.` };
      }
      scheduleServiceRestart(directory);
      return { restarted: true, scheduled: true };
    },
  };
}

export function createRemoteServer({
  directory = dataDirectory(),
  port = 43128,
  host = '127.0.0.1',
  allowHosts = [],
  poolBridge = null,
  store = null,
  managementToken = null,
  onShutdown = null,
  detectTailscale = detectTailscaleIp,
  detectTailscaleHttps = detectTailscaleHttpsUrl,
  activateTailscaleHttps = enableTailscaleHttps,
} = {}) {
  const remoteStore = store || new RemoteStore(directory);
  const pool = poolBridge || createPoolBridge(directory);
  let tailscaleIp = detectTailscale();
  let tailscaleHttpsUrl = null;
  let lastHttpsCheckAt = 0;
  const routeMetaCache = new Map();
  const pendingPairings = new Map(); // code -> { expiresAt, label }
  const readManagementToken = () => {
    if (managementToken) return managementToken;
    const file = path.join(directory, 'management-token');
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  };
  const tokenMatches = (provided, expected) => {
    if (!provided || !expected) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const staticFiles = new Map([
    ['/', ['text/html; charset=utf-8', () => readFileSync(path.join(publicDir, 'index.html'))]],
    ['/style.css', ['text/css; charset=utf-8', () => readFileSync(path.join(publicDir, 'style.css'))]],
    ['/app.js', ['text/javascript; charset=utf-8', () => readFileSync(path.join(publicDir, 'app.js'))]],
    ['/manifest.webmanifest', ['application/manifest+json; charset=utf-8', () => readFileSync(path.join(publicDir, 'manifest.webmanifest'))]],
    ['/icon.svg', ['image/svg+xml; charset=utf-8', () => readFileSync(path.join(publicDir, 'icon.svg'))]],
  ]);

  const prunePairings = () => {
    const now = Date.now();
    for (const [code, entry] of pendingPairings) {
      if (entry.expiresAt <= now) pendingPairings.delete(code);
    }
  };

  const createPairingCode = (label = 'Telefon') => {
    prunePairings();
    const code = randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 5 * 60_000;
    pendingPairings.set(code, { expiresAt, label });
    if (pendingPairings.size > 20) {
      const oldest = pendingPairings.keys().next().value;
      if (oldest) pendingPairings.delete(oldest);
    }
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  };

  // Create initial local pairing code at startup so desktop owner can sign in immediately.
  const initialPairing = createPairingCode('Ana Cihaz');

  const allowedHostSet = new Set(allowHosts.map(h => String(h).toLowerCase()));
  const isLoopbackAddr = req => {
    const remoteAddr = req.socket?.remoteAddress || '';
    return remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
  };
  const isDirectLoopback = (req, listenPort) => {
    if (!isLoopbackAddr(req)) return false;
    if ('x-forwarded-for' in req.headers || 'x-forwarded-host' in req.headers || 'x-forwarded-proto' in req.headers || 'tailscale-user-login' in req.headers) return false;
    const h = String(req.headers.host || '').toLowerCase();
    return h === `127.0.0.1:${listenPort}` || h === `localhost:${listenPort}`;
  };
  const hostAllowed = (reqHost, listenPort) => {
    if (!reqHost) return false;
    const lower = String(reqHost).toLowerCase();
    if (!/^[a-z0-9._:\[\]-]+$/.test(lower)) return false;
    if (lower === `127.0.0.1:${listenPort}` || lower === `localhost:${listenPort}`) return true;
    if (tailscaleIp && lower === `${tailscaleIp}:${listenPort}`) return true;
    if (host && host !== '0.0.0.0' && host !== 'tailscale' && lower === `${host.toLowerCase()}:${listenPort}`) return true;
    if (host === '0.0.0.0') return true;
    if (allowedHostSet.has(lower) || allowedHostSet.has(lower.split(':')[0])) return true;
    // Allow Tailscale MagicDNS (*.ts.net) only in tailscale mode; pin to detected Tailscale HTTPS host when known.
    if (host === 'tailscale') {
      if (tailscaleHttpsUrl) {
        try {
          const expectedHost = new URL(tailscaleHttpsUrl).host.toLowerCase();
          if (lower === expectedHost || lower === `${expectedHost.split(':')[0]}:${listenPort}`) return true;
        } catch { /* ignore */ }
      }
      if (/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(?::\d+)?$/.test(lower)) return true;
    }
    return false;
  };
  const originAllowed = req => {
    const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (sfs === 'cross-site') return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      return parsed.host.toLowerCase() === String(req.headers.host || '').toLowerCase();
    } catch { return false; }
  };
  const activeStreams = new Set();
  const MAX_STREAMS = 24;
  const securityHtmlHeaders = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  };

  const sendJson = (res, status, body) => {
    if (res.writableEnded) return;
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  };

  const unauthHtml = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CLI Agent Remote</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#0b0d12;color:#edf1f7;font:15px/1.6 system-ui,sans-serif}.box{max-width:440px;padding:24px;border:1px solid #262d3d;border-radius:16px;background:#141821}h1{margin:0 0 10px;font-size:19px}p{margin:0 0 10px;color:#9aa6bd;font-size:14px}strong{color:#edf1f7}</style></head><body><div class="box"><h1>Yetkilendirme Gerekli</h1><p>Bu cihaz henüz eşleştirilmemiş veya tek kullanımlık bağlantı daha önce kullanılmış.</p><p><strong>Bilgisayarda açmak için:</strong> Masaüstündeki <strong>CLI Agent Remote</strong> kısayoluna çift tıklayın veya CLI Agent Pool üst çubuğundaki <strong>Remote Sohbet</strong> düğmesine basın.</p><p><strong>Telefonda açmak için:</strong> Bilgisayarda açılan CLI Agent Remote ekranından <strong>Telefon Bağla (QR)</strong> kodunu telefon kamerasıyla okutun.</p></div></body></html>`;

  const syncTaskIntoChat = (chatId, taskId, task) => {
    if (!chatId || !taskId || !task) return;
    const evs = Array.isArray(task.events) ? task.events : [];
    const updatedMsg = remoteStore.updateTaskMessage(chatId, taskId, {
      state: task.state,
      queueReason: task.queueReason || null,
      blockedBy: task.blockedBy || null,
      result: task.result || '',
      error: task.error || null,
      errorDetail: task.errorDetail || '',
      report: task.report || null,
      reportedModel: task.reportedModel || null,
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      events: evs.slice(-30),
    });
    if (task.sessionId) {
      remoteStore.recordTaskSession(chatId, taskId, task.sessionId);
    }
    if (
      task.state === 'failed' &&
      updatedMsg?.resumedSessionId &&
      ['CLI_FAILED', 'INVALID_RESULT', 'PROTOCOL_ERROR'].includes(task.error)
    ) {
      remoteStore.clearChatNativeSession(chatId, updatedMsg.resumedSessionId);
    }
  };

  const handler = async (req, res) => {
    try {
    const actualPort = req.socket?.localPort || port;
    if (!hostAllowed(req.headers.host, actualPort)) {
      return sendJson(res, 403, { error: { code: 'HOST_DENIED', message: 'Bu host adresine erişim izni yok.' } });
    }
    let url;
    try { url = new URL(req.url || '/', `http://${req.headers.host}`); }
    catch { return sendJson(res, 400, { error: { code: 'INVALID_URL', message: 'Geçersiz adres.' } }); }

    const pathname = url.pathname;

    // Loopback-only management endpoint (authenticated with management-token)
    if (req.method === 'POST' && pathname === '/r/manage') {
      if (!isDirectLoopback(req, actualPort) || req.headers.host !== `127.0.0.1:${actualPort}` || 'origin' in req.headers || 'sec-fetch-site' in req.headers) {
        return sendJson(res, 403, { error: { code: 'ORIGIN_DENIED', message: 'Yönetim ucu yalnızca yerel makineden çağrılabilir.' } });
      }
      const authHeader = String(req.headers.authorization || '');
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!tokenMatches(bearer, readManagementToken())) {
        return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Yönetim anahtarı geçersiz.' } });
      }
      let body = {};
      try { body = await readJsonBody(req); } catch (err) {
        return sendJson(res, 400, { error: { code: err.code || 'INVALID_JSON', message: err.message } });
      }
      if (body.operation === 'pair_local') {
        await syncTailscaleListener();
        const created = createPairingCode(body.label || 'Bilgisayar');
        const localUrl = `http://127.0.0.1:${actualPort}/?pair=${created.code}`;
        const tailscaleUrl = tailscaleIp && servers.has(tailscaleIp)
          ? `http://${tailscaleIp}:${actualPort}/?pair=${created.code}`
          : null;
        return sendJson(res, 200, {
          dashboard: localUrl,
          localUrl,
          tailscaleUrl,
          port: actualPort,
          tailscaleIp,
          bindTargets: [...servers.keys()],
          version,
        });
      }
      if (body.operation === 'shutdown') {
        sendJson(res, 200, { stopped: true });
        setTimeout(() => {
          if (typeof onShutdown === 'function') void onShutdown();
          else void closeAll();
        }, 40);
        return;
      }
      return sendJson(res, 400, { error: { code: 'INVALID_REQUEST', message: 'Bilinmeyen yönetim işlemi.' } });
    }

    // Public PWA manifest & icon (no sensitive data)
    if (req.method === 'GET' && (pathname === '/manifest.webmanifest' || pathname === '/icon.svg')) {
      const [type, read] = staticFiles.get(pathname);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(read());
    }

    const cookies = parseCookies(req.headers.cookie);
    const existingDevice = remoteStore.verifyCookie(cookies.pool_remote);

    // One-time pairing handoff: GET /?pair=<code> (safe against camera/browser prefetchers & SameSite redirects)
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/' && url.searchParams.has('pair')) {
      if (existingDevice) {
        res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        return res.end();
      }
      const purpose = String(req.headers['sec-purpose'] || req.headers.purpose || req.headers['x-purpose'] || '').toLowerCase();
      if (req.method === 'HEAD' || /prefetch|preview|prerender/.test(purpose)) {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      prunePairings();
      const code = url.searchParams.get('pair') || '';
      if (!/^[a-f0-9]{16,128}$/.test(code) || !pendingPairings.has(code)) {
        res.writeHead(401, securityHtmlHeaders);
        return res.end(unauthHtml);
      }
      const redeemHtml = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CLI Agent Remote — Bağlanıyor</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#0b0d12;color:#edf1f7;font:15px/1.6 system-ui,sans-serif}.box{max-width:400px;width:100%;padding:24px;border:1px solid #262d3d;border-radius:16px;background:#141821;text-align:center}h1{margin:0 0 8px;font-size:19px}p{margin:0 0 16px;color:#9aa6bd;font-size:14px}button{min-height:44px;padding:0 18px;border:0;border-radius:10px;background:#0ea5e9;color:#fff;font:600 15px system-ui,sans-serif;cursor:pointer}</style></head><body><div class="box"><h1>Cihaz Eşleştiriliyor…</h1><p id="msg">Güvenli oturum hazırlanıyor, birkaç saniye içinde açılacak.</p><form method="post" action="/r/redeem"><input type="hidden" name="code" value="${code}"><button type="submit">Manuel Devam Et</button></form></div><script>(function(){fetch('/r/redeem',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({code:'${code}'})}).then(function(r){if(r.ok){location.replace('/');}else{document.getElementById('msg').textContent='Eşleştirme kodu geçersiz veya süresi dolmuş. Bilgisayardan yeni QR oluşturun.';}}).catch(function(){document.getElementById('msg').textContent='Sunucuya ulaşılamadı. Aşağıdaki düğmeye dokunarak tekrar deneyin.';});})();</script></body></html>`;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
      });
      return res.end(redeemHtml);
    }

    // One-time pairing redemption: POST /r/redeem (same-origin POST commits SameSite=Lax cookie reliably on iOS/Android)
    if (req.method === 'POST' && pathname === '/r/redeem') {
      if (!originAllowed(req)) {
        return sendJson(res, 403, { error: { code: 'ORIGIN_DENIED', message: 'Çapraz kaynak eşleştirme isteği reddedildi.' } });
      }
      prunePairings();
      let code = '';
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      const parts = [];
      let totalBytes = 0;
      for await (const chunk of req) {
        totalBytes += chunk.length;
        if (totalBytes > 4096) {
          req.resume();
          return sendJson(res, 413, { error: { code: 'REQUEST_TOO_LARGE', message: 'İstek çok büyük.' } });
        }
        parts.push(chunk);
      }
      const raw = Buffer.concat(parts).toString('utf8');
      if (ct.includes('application/json')) {
        try { code = String(JSON.parse(raw).code || ''); } catch { code = ''; }
      } else {
        code = new URLSearchParams(raw).get('code') || '';
      }
      const pending = pendingPairings.get(code);
      if (!pending) {
        if (ct.includes('application/json')) return sendJson(res, 401, { error: { code: 'INVALID_PAIR_CODE', message: 'Eşleştirme kodu geçersiz veya daha önce kullanılmış.' } });
        res.writeHead(401, securityHtmlHeaders);
        return res.end(unauthHtml);
      }
      pendingPairings.delete(code);
      const ua = String(req.headers['user-agent'] || '');
      const deviceHint = /android/i.test(ua) ? 'Android Telefon' : /iphone|ipad/i.test(ua) ? 'iPhone / iPad' : pending.label || 'Tarayıcı';
      const paired = remoteStore.pairDevice(deviceHint);
      const isHttps = (isLoopbackAddr(req) && req.headers['x-forwarded-proto'] === 'https') || Boolean(req.socket?.encrypted);
      // 1 yıl kalıcı oturum çerezi; QR kodu yalnız ilk eşleştirme için 5 dk geçerlidir, eşleşen cihaz ağdan düşmez.
      const cookie = `pool_remote=${paired.cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${isHttps ? '; Secure' : ''}`;
      if (ct.includes('application/json')) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': cookie,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        return res.end(JSON.stringify({ ok: true, device: { id: paired.id, label: paired.label } }));
      }
      res.writeHead(303, { Location: '/', 'Set-Cookie': cookie, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }

    const device = existingDevice;

    if (!device) {
      if (pathname.startsWith('/r/')) {
        return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Cihaz oturumu geçersiz. QR kodla yeniden eşleştirin.' } });
      }
      res.writeHead(401, securityHtmlHeaders);
      return res.end(unauthHtml);
    }

    // Enforce same-origin CSRF protection on all state-changing authenticated /r/* routes
    if (pathname.startsWith('/r/') && !['GET', 'HEAD'].includes(req.method) && !originAllowed(req)) {
      return sendJson(res, 403, { error: { code: 'ORIGIN_DENIED', message: 'Çapraz kaynak isteğine izin verilmiyor.' } });
    }

    // Authenticated static assets
    if (req.method === 'GET' && staticFiles.has(pathname)) {
      const [type, read] = staticFiles.get(pathname);
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'microphone=(self)',
        'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      });
      return res.end(read());
    }

    // SSE live task stream: GET /r/stream?taskId=...&chatId=...
    if (req.method === 'GET' && pathname === '/r/stream') {
      const taskId = url.searchParams.get('taskId') || '';
      const chatId = url.searchParams.get('chatId') || '';
      if (!taskId) return sendJson(res, 400, { error: { code: 'INVALID_REQUEST', message: 'taskId gerekli.' } });
      if (activeStreams.size >= MAX_STREAMS) {
        return sendJson(res, 429, { error: { code: 'BUSY', message: 'Çok fazla canlı akış açık.' } });
      }
      req.setTimeout?.(0);
      res.setTimeout?.(0);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      let streamClosed = false;
      const closeStream = () => { streamClosed = true; activeStreams.delete(res); };
      activeStreams.add(res);
      req.once('close', closeStream);
      res.once('close', closeStream);
      res.on('error', closeStream);
      let lastStamp = '';
      let lastWriteAt = Date.now();
      const push = (event, data) => {
        if (streamClosed || res.writableEnded) return;
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          lastWriteAt = Date.now();
        } catch { closeStream(); }
      };
      const loop = async () => {
        let consecutiveErrors = 0;
        let tick = 0;
        while (!streamClosed && !closed) {
          tick++;
          try {
            const task = await pool.task(taskId, false);
            consecutiveErrors = 0;
            const evs = Array.isArray(task.events) ? task.events : [];
            const lastSeq = evs.length ? (evs[evs.length - 1]?.seq ?? evs.length) : 0;
            const stamp = `${task.state}:${task.updated}:${task.queueReason || ''}:${task.blockedBy || ''}:${task.sessionId || ''}:${evs.length}:${lastSeq}:${(task.result || '').length}:${task.error || ''}:${(task.errorDetail || '').length}`;
            if (stamp !== lastStamp) {
              lastStamp = stamp;
              if (chatId) syncTaskIntoChat(chatId, taskId, task);
              push('update', { task });
            } else if (Date.now() - lastWriteAt >= 15_000 && !streamClosed && !res.writableEnded) {
              // Keep Tailscale HTTPS proxy & mobile carrier NAT alive during long silent tool steps.
              try { res.write(': keepalive\n\n'); lastWriteAt = Date.now(); } catch { closeStream(); break; }
            }
            if (TERMINAL_STATES.has(task.state)) {
              push('done', { task });
              break;
            }
          } catch (err) {
            consecutiveErrors++;
            const errCode = err instanceof PoolError ? err.code : 'STREAM_ERROR';
            if (consecutiveErrors >= 6 || errCode === 'NOT_FOUND' || errCode === 'UNAUTHORIZED') {
              push('stream_error', { code: errCode, message: err instanceof PoolError ? err.message : 'Görev durumu okunamadı.' });
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
          const delayMs = tick < 60 ? 250 : 500;
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        closeStream();
        if (!res.writableEnded) res.end();
      };
      void loop();
      return;
    }

    try {
      // GET /r/state — Full live dashboard snapshot
      if (req.method === 'GET' && pathname === '/r/state') {
        await syncTailscaleListener();
        const health = await pool.health();
        const running = health?.status === 'ok';
        let pools = [], models = [], quotas = [], connections = [], tasks = [];
        if (running) {
          const [pRes, mRes, qRes, cRes, tRes] = await Promise.allSettled([
            pool.pools(),
            pool.catalogModels(),
            pool.quotas(),
            pool.connections(),
            pool.tasks(60),
          ]);
          if (pRes.status === 'fulfilled') pools = pRes.value?.categories || pRes.value?.pools || (Array.isArray(pRes.value) ? pRes.value : []);
          if (mRes.status === 'fulfilled') models = mRes.value || [];
          if (qRes.status === 'fulfilled') quotas = qRes.value?.connections || (Array.isArray(qRes.value) ? qRes.value : []);
          if (cRes.status === 'fulfilled') connections = Array.isArray(cRes.value) ? cRes.value : [];
          if (tRes.status === 'fulfilled') tasks = Array.isArray(tRes.value) ? tRes.value : (tRes.value?.tasks || []);

          // Build route metadata map (toolLabel, email, account, billing)
          const routeMetaByRoute = new Map();
          for (const c of connections) {
            routeMetaByRoute.set(c.id, { adapter: c.adapter || '', email: c.email || '', account: c.account || '', billing: c.billing || '' });
          }
          for (const q of quotas) {
            const prev = routeMetaByRoute.get(q.routeId) || {};
            routeMetaByRoute.set(q.routeId, {
              adapter: prev.adapter || q.adapter || '',
              email: prev.email || q.email || '',
              account: prev.account || q.account || '',
              billing: prev.billing || q.billing || '',
              quotaStatus: q.status || prev.quotaStatus || '',
            });
          }
          routeMetaCache.clear();
          for (const [k, v] of routeMetaByRoute.entries()) {
            routeMetaCache.set(k, { ...v, toolLabel: toolLabelFor(v.adapter) });
          }

          // Fetch cached per-route quota windows so every model displays 5s / 7g inline badges
          const routeWindowsByRoute = new Map();
          if (quotas.length && typeof pool.routeQuota === 'function') {
            const detailRes = await Promise.allSettled(quotas.map(q => pool.routeQuota(q.routeId)));
            quotas = quotas.map((q, idx) => {
              const wins = detailRes[idx]?.status === 'fulfilled'
                ? (detailRes[idx].value?.connections?.[0]?.windows || detailRes[idx].value?.windows || [])
                : [];
              if (wins.length) routeWindowsByRoute.set(q.routeId, wins);
              const meta = routeMetaByRoute.get(q.routeId) || {};
              return { ...q, toolLabel: toolLabelFor(q.adapter || meta.adapter), email: q.email || meta.email || '', windows: wins };
            });
          }

          models = sortModelsAlpha(models.map(m => enrichModel(m, routeWindowsByRoute, routeMetaByRoute)));
          if (pools.length && typeof pool.poolModels === 'function') {
            const perPool = await Promise.allSettled(pools.map(p => pool.poolModels(p.id)));
            pools = pools.map((p, idx) => ({
              ...p,
              label: p.label || p.name || p.id,
              models: sortModelsAlpha(
                (perPool[idx]?.status === 'fulfilled' ? (perPool[idx].value?.models || []) : [])
                  .map(m => enrichModel(m, routeWindowsByRoute, routeMetaByRoute)),
              ),
            }));
          } else {
            pools = pools.map(p => ({ ...p, label: p.label || p.name || p.id }));
          }
          // Enrich active tasks (queued/starting/running/cancelling) with live progress events, queueReason & blockedBy
          const activeTaskIds = tasks.filter(t => !TERMINAL_STATES.has(t.state)).slice(0, 10);
          const activeDetails = new Map();
          if (activeTaskIds.length && typeof pool.task === 'function') {
            const detailRes = await Promise.allSettled(activeTaskIds.map(t => pool.task(t.id, false)));
            activeTaskIds.forEach((t, idx) => {
              if (detailRes[idx]?.status === 'fulfilled' && detailRes[idx].value) {
                activeDetails.set(t.id, detailRes[idx].value);
              }
            });
          }
          tasks = tasks.map(t => {
            const meta = routeMetaByRoute.get(t.routeId) || {};
            const extra = activeDetails.get(t.id);
            return {
              ...t,
              queueReason: extra?.queueReason ?? t.queueReason ?? null,
              blockedBy: extra?.blockedBy ?? t.blockedBy ?? null,
              events: extra?.events ? extra.events.slice(-15) : (t.events || []),
              errorDetail: extra?.errorDetail ?? t.errorDetail ?? '',
              toolLabel: toolLabelFor(meta.adapter),
              email: meta.email || '',
              account: meta.account || '',
            };
          });
          tasks.sort((a, b) => Number(!TERMINAL_STATES.has(b.state)) - Number(!TERMINAL_STATES.has(a.state)));
        }
        const cfg = pool.getConfig();
        const mergedShared = [...new Set([...(cfg.workspaceRoots || []), ...remoteStore.state.sharedFolders])];
        return sendJson(res, 200, {
          remoteVersion: version,
          device,
          poolHealth: health,
          pools,
          models,
          quotas,
          connections,
          tasks,
          chats: remoteStore.listChats(),
          sharedFolders: mergedShared,
          favoriteFolders: remoteStore.state.favoriteFolders,
          recentFolders: remoteStore.state.recentFolders,
          workspaceRoots: cfg.workspaceRoots || [],
          canPickNativeFolder: process.platform === 'win32' && isDirectLoopback(req, actualPort),
          devices: remoteStore.listDevices(),
          tailscaleIp,
          tailscaleHttpsUrl,
          port: actualPort,
          hostMode: host,
        });
      }

      // GET /r/dirs?path=...
      if (req.method === 'GET' && pathname === '/r/dirs') {
        const cfg = pool.getConfig();
        const requested = url.searchParams.get('path') || '';
        const browseAll = url.searchParams.get('browseAll') === '1';
        const mergedRoots = [...new Set([...(cfg.workspaceRoots || []), ...remoteStore.state.sharedFolders])];
        const effectiveRoots = browseAll ? [] : mergedRoots;
        const result = listDirectoriesSafe(requested, effectiveRoots);
        return sendJson(res, 200, {
          ...result,
          canBrowseAll: mergedRoots.length > 0 && !browseAll,
        });
      }

      // POST /r/folders/favorite
      if (req.method === 'POST' && pathname === '/r/folders/favorite') {
        const body = await readJsonBody(req);
        const rawPath = String(body.path || '').trim();
        if (body.action === 'remove') {
          const norm = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
          const targetKey = rawPath ? norm(rawPath) : '';
          remoteStore.state.favoriteFolders = remoteStore.state.favoriteFolders.filter(f => norm(f) !== targetKey);
          remoteStore.writeState();
          return sendJson(res, 200, { favoriteFolders: remoteStore.state.favoriteFolders });
        }
        const checked = listDirectoriesSafe(rawPath, []);
        const favoriteFolders = remoteStore.toggleFavoriteFolder(checked.current);
        return sendJson(res, 200, { favoriteFolders });
      }

      // POST /r/folders/shared — add or remove shared drives/project roots (syncs with Pool workspaceRoots)
      if (req.method === 'POST' && pathname === '/r/folders/shared') {
        const body = await readJsonBody(req);
        const action = body.action === 'remove' ? 'remove' : 'add';
        if (action === 'remove') {
          const target = String(body.path || '').trim();
          const norm = p => {
            try { return process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p); }
            catch { return String(p || '').trim().toLowerCase(); }
          };
          const targetKey = target ? norm(target) : '';
          remoteStore.state.sharedFolders = remoteStore.state.sharedFolders.filter(f => norm(f) !== targetKey);
          remoteStore.state.favoriteFolders = remoteStore.state.favoriteFolders.filter(f => norm(f) !== targetKey);
          remoteStore.writeState();
          let nextRoots = [];
          try {
            if (typeof pool.manageGet === 'function' && typeof pool.manageSave === 'function') {
              const view = await pool.manageGet();
              const roots = (view.config.workspaceRoots || []).filter(r => norm(r) !== targetKey);
              if (roots.length !== (view.config.workspaceRoots || []).length) {
                await pool.manageSave({ ...view.config, workspaceRoots: roots }, view.revision);
              }
              nextRoots = roots;
            }
          } catch { /* keep remote store updated */ }
          return sendJson(res, 200, {
            sharedFolders: [...new Set([...nextRoots, ...remoteStore.state.sharedFolders])],
            favoriteFolders: remoteStore.state.favoriteFolders,
          });
        }
        // Owner explicitly adding a new drive or folder root: validate directory exists on disk without workspaceRoots block
        const checked = listDirectoriesSafe(body.path || '', []);
        if (!checked.current) throw new PoolError('INVALID_WORKSPACE', 'Geçerli bir disk veya klasör yolu girin (örn. D:\\ veya D:\\repositories).');
        remoteStore.addSharedFolder(checked.current);
        let nextRoots = [];
        try {
          if (typeof pool.manageGet === 'function' && typeof pool.manageSave === 'function') {
            const view = await pool.manageGet();
            const existing = Array.isArray(view.config.workspaceRoots) ? view.config.workspaceRoots : [];
            const roots = existing.includes(checked.current) ? existing : [...existing, checked.current];
            if (roots.length !== existing.length) {
              await pool.manageSave({ ...view.config, workspaceRoots: roots }, view.revision);
            }
            nextRoots = roots;
          }
        } catch { /* keep remote store updated */ }
        return sendJson(res, 200, {
          sharedFolders: [...new Set([...nextRoots, ...remoteStore.state.sharedFolders])],
          added: checked.current,
        });
      }

      // POST /r/folders/pick — native Windows folder dialog (direct loopback desktop only; never via Tailscale Serve proxy)
      if (req.method === 'POST' && pathname === '/r/folders/pick') {
        if (!isDirectLoopback(req, actualPort)) {
          throw new PoolError('PICKER_UNAVAILABLE', 'Yerel Windows klasör seçicisi yalnızca bilgisayar ekranında açılabilir; telefonda web klasör gezginini kullanın.');
        }
        const body = await readJsonBody(req);
        const picked = await pickWindowsFolder(body.initialPath || '', { directory });
        const pickedPath = typeof picked === 'string' ? picked : (picked?.path || '');
        return sendJson(res, 200, { path: pickedPath, cancelled: !pickedPath });
      }

      // GET /r/file?workspace=...&file=... — safely read a workspace output document (<= 512 KB)
      if (req.method === 'GET' && pathname === '/r/file') {
        const ws = url.searchParams.get('workspace') || '';
        const rel = url.searchParams.get('file') || '';
        if (!ws || !rel) throw new PoolError('INVALID_REQUEST', 'workspace ve file parametreleri gerekli.');
        const cfg = pool.getConfig();
        const chatWorkspaces = remoteStore.state.chats.map(c => c.workspace).filter(Boolean);
        const allowedRoots = [...new Set([...(cfg.workspaceRoots || []), ...remoteStore.state.sharedFolders, ...chatWorkspaces])];
        if (!allowedRoots.length) {
          throw new PoolError('WORKSPACE_DENIED', 'Dosya önizleme için önce bir proje klasörü paylaşın veya sohbet çalışma klasörü seçin.');
        }
        const checkedWs = listDirectoriesSafe(ws, allowedRoots);
        if (isSensitiveSystemPath(checkedWs.current, directory)) {
          throw new PoolError('WORKSPACE_DENIED', 'Hassas sistem veya uygulama veri klasörleri okunamaz.');
        }
        const candidate = path.isAbsolute(rel) ? rel : path.resolve(checkedWs.current, rel);
        let realFile;
        try { realFile = realpathSync(candidate); } catch { throw new PoolError('NOT_FOUND', 'Dosya bulunamadı.'); }
        if (!pathWithinRoot(realFile, checkedWs.current) || isSensitiveSystemPath(realFile, directory)) {
          throw new PoolError('WORKSPACE_DENIED', 'Dosya seçili proje klasörünün dışında.');
        }
        const st = statSync(realFile);
        if (!st.isFile()) throw new PoolError('INVALID_REQUEST', 'Seçilen yol bir dosya değil.');
        const buf = readFileSync(realFile);
        if (buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) {
          throw new PoolError('INVALID_REQUEST', 'İkili (binary) dosyalar metin önizleyicide açılamaz.');
        }
        const content = buf.toString('utf8');
        return sendJson(res, 200, { name: path.basename(realFile), path: realFile, size: st.size, content });
      }

      // POST /r/pool/membership — add or remove a model from a pool category
      if (req.method === 'POST' && pathname === '/r/pool/membership') {
        const body = await readJsonBody(req);
        const { routeId, modelId, group, action = 'add', effort } = body;
        if (!routeId || !modelId || !group) throw new PoolError('INVALID_REQUEST', 'routeId, modelId ve group gerekli.');
        const view = await pool.manageGet();
        const nextConfig = structuredClone(view.config);
        const route = nextConfig.routes.find(r => r.id === routeId);
        const model = route?.models?.find(m => m.id === modelId);
        if (!model) throw new PoolError('NOT_FOUND', 'Model bulunamadı.');
        const memberships = Array.isArray(model.memberships)
          ? [...model.memberships]
          : (model.group && model.group !== 'unassigned' ? [{ group: model.group, ...(model.defaultEffort ? { effort: model.defaultEffort } : {}) }] : []);
        const filtered = memberships.filter(m => m.group !== group);
        if (action === 'add') {
          const cleanEff = effort && effort !== 'default' ? effort : undefined;
          filtered.push({ group, ...(cleanEff ? { effort: cleanEff } : {}) });
          model.enabled = true;
          if (Array.isArray(nextConfig.modelFilters)) {
            nextConfig.modelFilters = nextConfig.modelFilters.filter(f =>
              !(f.match === 'model' && f.value === modelId && (!f.routeId || f.routeId === routeId)),
            );
          }
        }
        model.memberships = filtered;
        model.group = filtered[0]?.group || 'unassigned';
        await pool.manageSave(nextConfig, view.revision);
        return sendJson(res, 200, { updated: true, memberships: model.memberships });
      }

      // POST /r/pool/model-toggle — enable or disable a model in a route
      if (req.method === 'POST' && pathname === '/r/pool/model-toggle') {
        const body = await readJsonBody(req);
        const { routeId, modelId, enabled } = body;
        if (!routeId || !modelId || typeof enabled !== 'boolean') throw new PoolError('INVALID_REQUEST', 'routeId, modelId ve enabled gerekli.');
        const view = await pool.manageGet();
        const nextConfig = structuredClone(view.config);
        const route = nextConfig.routes.find(r => r.id === routeId);
        const model = route?.models?.find(m => m.id === modelId);
        if (!model) throw new PoolError('NOT_FOUND', 'Model bulunamadı.');
        model.enabled = enabled;
        await pool.manageSave(nextConfig, view.revision);
        return sendJson(res, 200, { updated: true, enabled });
      }

      // Chats CRUD
      if (req.method === 'GET' && pathname === '/r/chats') {
        return sendJson(res, 200, { chats: remoteStore.listChats() });
      }
      if (req.method === 'POST' && pathname === '/r/chats') {
        const body = await readJsonBody(req);
        const chat = remoteStore.createChat({ title: body.title, workspace: body.workspace });
        return sendJson(res, 201, { chat });
      }
      const chatMatch = /^\/r\/chats\/([a-zA-Z0-9-]+)(?:\/(send))?$/.exec(pathname);
      if (chatMatch) {
        const [, chatId, sub] = chatMatch;
        if (req.method === 'GET' && !sub) {
          const chat = remoteStore.getChat(chatId);
          if (!chat) throw new PoolError('NOT_FOUND', 'Sohbet bulunamadı.');
          // Refresh any still-active task messages in this chat from pool
          for (const msg of chat.messages) {
            if (msg.role === 'assistant' && msg.taskId && !TERMINAL_STATES.has(msg.state)) {
              try {
                const live = await pool.task(msg.taskId, false);
                syncTaskIntoChat(chatId, msg.taskId, live);
              } catch { /* keep cached */ }
            }
          }
          return sendJson(res, 200, { chat: remoteStore.getChat(chatId) });
        }
        if (req.method === 'PATCH' && !sub) {
          const body = await readJsonBody(req);
          const chat = remoteStore.updateChat(chatId, body);
          if (!chat) throw new PoolError('NOT_FOUND', 'Sohbet bulunamadı.');
          return sendJson(res, 200, { chat });
        }
        if (req.method === 'DELETE' && !sub) {
          if (!remoteStore.deleteChat(chatId)) throw new PoolError('NOT_FOUND', 'Sohbet bulunamadı.');
          return sendJson(res, 200, { deleted: true });
        }
        if (req.method === 'POST' && sub === 'send') {
          const chat = remoteStore.getChat(chatId);
          if (!chat) throw new PoolError('NOT_FOUND', 'Sohbet bulunamadı.');
          const body = await readJsonBody(req);
          const rawPrompt = String(body.prompt || '').trim();
          const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
          const cleanAttachments = [];
          for (const att of rawAttachments) {
            const name = String(att?.name || 'dokuman.txt').replace(/[\u0000-\u001f\u007f\\/]/g, '_').trim().slice(0, 120) || 'dokuman.txt';
            const content = String(att?.content || '');
            if (!content.trim()) continue;
            cleanAttachments.push({ name, size: Buffer.byteLength(content, 'utf8'), content });
          }
          if (!rawPrompt && !cleanAttachments.length) {
            throw new PoolError('INVALID_REQUEST', 'Gönderilecek mesaj veya doküman boş olamaz.');
          }

          const requestedWorkspace = body.workspace !== undefined ? String(body.workspace || '').trim() : String(chat.workspace || '').trim();
          const cfg = pool.getConfig();
          let canonicalWorkspace = '';
          let hasProject = false;

          if (requestedWorkspace) {
            const checkedDir = listDirectoriesSafe(requestedWorkspace, cfg.workspaceRoots || []);
            if (isSensitiveSystemPath(checkedDir.current, directory)) {
              throw new PoolError('WORKSPACE_DENIED', 'Hassas sistem veya uygulama veri klasöründe görev çalıştırılamaz.');
            }
            canonicalWorkspace = cfg.workspaceRoots?.length ? allowedWorkspace(checkedDir.current, cfg.workspaceRoots) : checkedDir.current;
            hasProject = true;
          } else {
            // Projesiz (Sohbet) modu: izole boş sohbet sandbox klasörü kullan; hiçbir proje klasörüne veya kilidine temas etme.
            const sandbox = path.join(directory, 'remote-chat-sandbox');
            mkdirSync(sandbox, { recursive: true, mode: 0o700 });
            canonicalWorkspace = realpathSync(sandbox);
          }

          const kind = hasProject
            ? (['text', 'read', 'write'].includes(body.kind) ? body.kind : 'write')
            : 'text';
          // Proje sohbetlerinde execute JSON rapor sözleşmesini zorunlu kılma;
          // model normal CLI gibi sohbet edebilir veya dosya düzenleyebilir.
          const mode = !hasProject
            ? 'response'
            : (body.mode === 'execute' && kind === 'write')
              ? 'execute'
              : (body.mode === 'response' && kind !== 'write')
                ? 'response'
                : undefined;
          const cleanEffort = body.effort && body.effort !== 'default' ? String(body.effort) : '';
          const includeContext = body.includeContext !== false;
          const docBlocks = cleanAttachments.map(a => `[Eklenen Doküman: ${a.name}]\n${a.content}\n[/Eklenen Doküman]`).join('\n\n');
          const combinedUserPrompt = [rawPrompt, docBlocks].filter(Boolean).join('\n\n');

          // Native CLI session continuity:
          // chat.nativeSession is the sole source of truth so clearChatNativeSession()
          // actually prevents resurrecting broken/expired CLI sessions.
          const chatWsKey = hasProject ? canonicalWorkspace : '';
          const reqRouteId = body.routeId ? String(body.routeId) : '';
          const reqModelId = body.modelId ? String(body.modelId) : '';
          const reqGroup = body.group ? String(body.group) : '';
          const candidateSession = chat.nativeSession?.sessionId ? chat.nativeSession : null;

          let resumeSession = null;
          if (includeContext && candidateSession?.sessionId && (candidateSession.workspace || '') === chatWsKey) {
            const explicitTarget = Boolean(reqRouteId || reqModelId);
            const sameTarget = explicitTarget
              ? ((!reqRouteId || reqRouteId === candidateSession.routeId) && (!reqModelId || reqModelId === candidateSession.modelId))
              : (!reqGroup || !candidateSession.group || reqGroup === candidateSession.group);
            if (sameTarget && candidateSession.routeId && candidateSession.modelId) {
              resumeSession = candidateSession;
            }
          }

          const finalPrompt = resumeSession
            ? combinedUserPrompt
            : (() => {
                const builtPrompt = buildCompactPrompt(chat, combinedUserPrompt, includeContext);
                return hasProject
                  ? builtPrompt
                  : `[Genel sohbet modu: Şu an bir proje klasörüne veya git deposuna bağlı değilsin. Dosya/repo arama veya repo uyarısı yapma; doğrudan kullanıcının mesajına doğal yanıt ver.]\n\n${builtPrompt}`;
              })();

          // Sessions run until completion or explicit cancellation (0 = no timeout).
          const timeoutSeconds = 0;
          const taskReq = {
            prompt: finalPrompt,
            workspace: canonicalWorkspace,
            kind,
            ...(mode ? { mode } : {}),
            ...(reqGroup ? { group: reqGroup } : {}),
            ...(resumeSession ? { routeId: resumeSession.routeId, modelId: resumeSession.modelId } : {
              ...(reqRouteId ? { routeId: reqRouteId } : {}),
              ...(reqModelId ? { modelId: reqModelId } : {}),
            }),
            ...(cleanEffort ? { effort: cleanEffort } : {}),
            persistSession: true,
            ...(resumeSession ? { sessionId: resumeSession.sessionId } : {}),
            timeoutSeconds,
            clientLabel: `Remote (${device.label})`,
            idempotencyKey: `remote-${randomUUID()}`,
          };

          const submitted = await pool.submit(taskReq);
          if (hasProject) remoteStore.updateChat(chatId, { workspace: canonicalWorkspace });
          else if (chat.workspace) remoteStore.updateChat(chatId, { workspace: '' });
          // Resolve toolLabel & subscription/email metadata from cache (zero extra HTTP roundtrip on hot path)
          let routeMeta = routeMetaCache.get(submitted.routeId) || { adapter: '', toolLabel: '', email: '', account: '', billing: '' };
          if (!routeMeta.toolLabel) {
            try {
              const conns = await pool.connections();
              const found = (Array.isArray(conns) ? conns : []).find(c => c.id === submitted.routeId);
              if (found) {
                routeMeta = {
                  adapter: found.adapter || '',
                  toolLabel: toolLabelFor(found.adapter),
                  email: found.email || '',
                  account: found.account || '',
                  billing: found.billing || '',
                };
                routeMetaCache.set(submitted.routeId, routeMeta);
              }
            } catch { /* best-effort */ }
          }

          const userMsg = remoteStore.appendMessage(chatId, {
            role: 'user',
            text: rawPrompt || `📎 ${cleanAttachments.map(a => a.name).join(', ')}`,
            workspace: hasProject ? canonicalWorkspace : '',
            kind,
            mode,
            includeContext,
            attachments: cleanAttachments.map(a => ({ name: a.name, size: a.size, content: a.content.slice(0, 60_000) })),
          });
          const assistantMsg = remoteStore.appendMessage(chatId, {
            role: 'assistant',
            text: '',
            taskId: submitted.id,
            routeId: submitted.routeId,
            modelId: submitted.modelId,
            adapter: routeMeta.adapter,
            toolLabel: routeMeta.toolLabel,
            email: routeMeta.email,
            account: routeMeta.account,
            billing: routeMeta.billing,
            workspace: hasProject ? canonicalWorkspace : '',
            group: submitted.group || reqGroup || null,
            effort: (submitted.effort && submitted.effort !== 'default') ? submitted.effort : (cleanEffort || null),
            kind,
            mode,
            sessionId: submitted.sessionId || (resumeSession ? resumeSession.sessionId : null),
            resumedSessionId: resumeSession ? resumeSession.sessionId : null,
            resumedSession: Boolean(resumeSession),
            state: submitted.state || 'queued',
            queueReason: submitted.queueReason || null,
            blockedBy: submitted.blockedBy || null,
            result: submitted.result || '',
            error: submitted.error || null,
            errorDetail: submitted.errorDetail || '',
            report: submitted.report || null,
            events: [],
          });
          if (submitted.sessionId) {
            remoteStore.recordTaskSession(chatId, submitted.id, submitted.sessionId);
          } else if (!resumeSession) {
            // Switched model/route/workspace: clear old nativeSession until the new CLI emits its own sessionId
            remoteStore.clearChatNativeSession(chatId);
          }
          return sendJson(res, 200, {
            chat: remoteStore.getChat(chatId),
            userMessage: userMsg,
            assistantMessage: assistantMsg,
            task: submitted,
          });
        }
      }

      // Clear completed call history
      if (req.method === 'POST' && pathname === '/r/tasks/clear') {
        return sendJson(res, 200, await pool.clearHistory());
      }

      // Tasks direct inspect, delete, resolve & cancel
      const taskMatch = /^\/r\/tasks\/([a-zA-Z0-9-]+)(?:\/(cancel|resolve))?$/.exec(pathname);
      if (taskMatch) {
        const [, taskId, sub] = taskMatch;
        if (req.method === 'GET' && !sub) {
          return sendJson(res, 200, { task: await pool.task(taskId, false) });
        }
        if (req.method === 'DELETE' && !sub) {
          return sendJson(res, 200, await pool.deleteTask(taskId));
        }
        if (req.method === 'POST' && sub === 'cancel') {
          return sendJson(res, 200, { task: await pool.cancel(taskId) });
        }
        if (req.method === 'POST' && sub === 'resolve') {
          const body = await readJsonBody(req);
          return sendJson(res, 200, { resolved: true, task: await pool.resolveTask(taskId, body.note) });
        }
      }

      // Pool lifecycle controls
      if (req.method === 'POST' && pathname === '/r/pool/start') {
        return sendJson(res, 200, await pool.startPool());
      }
      if (req.method === 'POST' && pathname === '/r/pool/stop') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, await pool.stopPool(Boolean(body.force)));
      }
      if (req.method === 'POST' && pathname === '/r/pool/restart') {
        return sendJson(res, 200, await pool.restartPool());
      }
      if (req.method === 'POST' && pathname === '/r/quotas/refresh') {
        const conns = await pool.connections();
        await Promise.allSettled((conns || []).map(c => (typeof pool.refreshRouteAuth === 'function' ? pool.refreshRouteAuth(c.id) : pool.liveQuota(c.id))));
        return sendJson(res, 200, { quotas: await pool.quotas() });
      }
      const routeActionMatch = /^\/r\/routes\/([^/]+)\/(refresh-auth|login)$/.exec(pathname);
      if (routeActionMatch && req.method === 'POST') {
        let routeId;
        try { routeId = decodeURIComponent(routeActionMatch[1]); }
        catch { throw new PoolError('INVALID_REQUEST', 'Geçersiz bağlantı kimliği.'); }
        const action = routeActionMatch[2];
        if (action === 'refresh-auth') {
          const snapshot = typeof pool.refreshRouteAuth === 'function'
            ? await pool.refreshRouteAuth(routeId)
            : await pool.liveQuota(routeId);
          return sendJson(res, 200, { refreshed: true, routeId, quota: snapshot });
        }
        if (action === 'login') {
          if (typeof pool.loginRoute !== 'function') {
            throw new PoolError('LOGIN_UNAVAILABLE', 'Bu ortamda uzak giriş tetikleme desteklenmiyor.');
          }
          const result = await pool.loginRoute(routeId);
          return sendJson(res, 200, { routeId, ...result });
        }
      }

      // Enable Tailscale HTTPS proxy (tailscale serve --bg <port>) for mobile mic & PWA
      if (req.method === 'POST' && pathname === '/r/tailscale/https') {
        const httpsUrl = await activateTailscaleHttps(actualPort);
        tailscaleHttpsUrl = httpsUrl;
        lastHttpsCheckAt = Date.now();
        return sendJson(res, 200, { enabled: true, tailscaleHttpsUrl: httpsUrl });
      }

      // Pairing & device management
      if (req.method === 'POST' && pathname === '/r/pair') {
        await syncTailscaleListener(true);
        const body = await readJsonBody(req);
        const created = createPairingCode(body.label || 'Telefon');
        const useTs = body.useTailscale !== false;
        let pairUrl;
        if (useTs && tailscaleHttpsUrl) {
          pairUrl = `${tailscaleHttpsUrl.replace(/\/$/, '')}/?pair=${created.code}`;
        } else {
          const preferredHost = useTs && tailscaleIp ? `${tailscaleIp}:${actualPort}` : req.headers.host;
          const proto = (isLoopbackAddr(req) && req.headers['x-forwarded-proto'] === 'https') || Boolean(req.socket?.encrypted) ? 'https' : 'http';
          pairUrl = `${proto}://${preferredHost}/?pair=${created.code}`;
        }
        return sendJson(res, 200, {
          ...created,
          url: pairUrl,
          localUrl: `http://127.0.0.1:${actualPort}/?pair=${created.code}`,
          tailscaleIp,
          tailscaleHttpsUrl,
          qrSvg: qrSvg(pairUrl),
        });
      }
      if (req.method === 'GET' && pathname === '/r/devices') {
        return sendJson(res, 200, { devices: remoteStore.listDevices(), currentDeviceId: device.id });
      }
      if (req.method === 'POST' && pathname === '/r/devices/revoke') {
        const body = await readJsonBody(req);
        const removed = remoteStore.revokeDevice(body.deviceId);
        const selfRevoked = removed && body.deviceId === device.id;
        if (selfRevoked && !res.writableEnded) {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Set-Cookie': 'pool_remote=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
          });
          return res.end(JSON.stringify({ revoked: removed, selfRevoked: true, devices: remoteStore.listDevices() }));
        }
        return sendJson(res, 200, { revoked: removed, devices: remoteStore.listDevices() });
      }

      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Uç nokta bulunamadı.' } });
    } catch (error) {
      const code = error instanceof PoolError ? error.code : 'INTERNAL_ERROR';
      const status = code === 'INVALID_REQUEST' || code === 'INVALID_JSON' || code === 'INVALID_WORKSPACE' ? 400
        : code === 'WORKSPACE_DENIED' || code === 'HOST_DENIED' || code === 'ORIGIN_DENIED' ? 403
        : code === 'NOT_FOUND' ? 404
        : code === 'REQUEST_TOO_LARGE' ? 413
        : code === 'CONTENT_TYPE' ? 415
        : code === 'INTERNAL_ERROR' ? 500 : 409;
      return sendJson(res, status, { error: { code, message: error instanceof PoolError ? error.message : 'İşlem tamamlanamadı.' } });
    }
    } catch (outerErr) {
      return sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'İşlem tamamlanamadı.' } });
    }
  };

  const servers = new Map(); // bindHost -> http.Server
  let activePort = port;
  let syncInFlight = null;
  let closed = false;
  const bindTargets = host === 'tailscale'
    ? (tailscaleIp ? ['127.0.0.1', tailscaleIp] : ['127.0.0.1'])
    : [host];

  const bindHostServer = async bindHost => {
    if (servers.has(bindHost) || closed) return;
    const srv = http.createServer((req, res) => {
      void handler(req, res).catch(() => {
        if (!res.writableEnded) sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'İşlem tamamlanamadı.' } });
      });
    });
    srv.keepAliveTimeout = 65_000;
    srv.headersTimeout = 15_000;
    srv.maxHeadersCount = 48;
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(activePort, bindHost, () => {
        srv.off('error', reject);
        activePort = srv.address().port;
        resolve();
      });
    });
    servers.set(bindHost, srv);
    if (!bindTargets.includes(bindHost)) bindTargets.push(bindHost);
  };

  // Dynamically detect Tailscale IP & active Tailscale HTTPS serve without restarting Remote.
  const syncTailscaleListener = async (forceHttpsCheck = false) => {
    if (closed) return tailscaleIp;
    if (syncInFlight) return syncInFlight;
    const job = (async () => {
      const latest = detectTailscale();
      tailscaleIp = latest || null;
      if (host === 'tailscale' && servers.size) {
        // Close stale non-loopback Tailscale listeners if IP changed or disconnected
        for (const [boundHost, srv] of [...servers.entries()]) {
          if (boundHost !== '127.0.0.1' && boundHost !== tailscaleIp) {
            servers.delete(boundHost);
            try { srv.closeAllConnections?.(); } catch { /* ignore */ }
            await new Promise(resolve => srv.close(() => resolve()));
          }
        }
        if (tailscaleIp && !servers.has(tailscaleIp)) {
          try { await bindHostServer(tailscaleIp); } catch { /* interface may still be settling */ }
        }
      }
      if (tailscaleIp && (forceHttpsCheck || Date.now() - lastHttpsCheckAt > 20_000)) {
        lastHttpsCheckAt = Date.now();
        try { tailscaleHttpsUrl = await detectTailscaleHttps(activePort); } catch { tailscaleHttpsUrl = null; }
      } else if (!tailscaleIp) {
        tailscaleHttpsUrl = null;
      }
      return tailscaleIp;
    })();
    syncInFlight = job;
    try { return await job; } finally { if (syncInFlight === job) syncInFlight = null; }
  };

  let tsPollTimer = null;
  const closeAll = async () => {
    closed = true;
    if (tsPollTimer) { clearInterval(tsPollTimer); tsPollTimer = null; }
    await Promise.all([...servers.values()].map(s => new Promise(resolve => {
      try { s.closeAllConnections?.(); } catch { /* ignore */ }
      s.close(() => resolve());
    })));
    servers.clear();
  };

  return {
    store: remoteStore,
    get tailscaleIp() { return tailscaleIp; },
    bindTargets,
    initialPairingCode: initialPairing.code,
    createPairingCode,
    syncTailscaleListener,
    async listen() {
      tailscaleIp = detectTailscale();
      const initialTargets = host === 'tailscale'
        ? (tailscaleIp ? ['127.0.0.1', tailscaleIp] : ['127.0.0.1'])
        : [host];
      for (const bindHost of initialTargets) {
        try {
          await bindHostServer(bindHost);
        } catch (err) {
          if (bindHost === '127.0.0.1' || host !== 'tailscale') throw err;
        }
      }
      if (host === 'tailscale' && !tsPollTimer) {
        tsPollTimer = setInterval(() => { void syncTailscaleListener(); }, 15_000);
        tsPollTimer.unref();
      }
      if (tailscaleIp) {
        lastHttpsCheckAt = Date.now();
        void Promise.resolve(detectTailscaleHttps(activePort)).then(u => { tailscaleHttpsUrl = u || null; }).catch(() => {});
      }
      const localUrl = `http://127.0.0.1:${activePort}/?pair=${initialPairing.code}`;
      const tailscaleUrl = tailscaleIp && servers.has(tailscaleIp)
        ? `http://${tailscaleIp}:${activePort}/?pair=${initialPairing.code}`
        : null;
      return { port: activePort, bindTargets: [...servers.keys()], tailscaleIp, localUrl, tailscaleUrl };
    },
    close: closeAll,
  };
}
