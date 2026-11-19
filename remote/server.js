import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedWorkspace, configView, dataDirectory, PoolError } from '../src/config.js';
import { ensureDaemon, ensureInitialized, managementRequest, scheduleServiceRestart } from '../src/daemon.js';
import { version } from '../src/version.js';
import { qrSvg } from './qr.js';
import { buildCompactPrompt, RemoteStore } from './store.js';

const publicDir = fileURLToPath(new URL('./public', import.meta.url));
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'needs_review']);
const SKIP_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git', '.hg', '.svn']);

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
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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
    const candidates = [
      ...(process.platform === 'win32' ? ['D:\\repositories', 'C:\\repositories', 'D:\\', 'C:\\'] : ['/']),
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
      if (!dirent.isDirectory()) continue;
      if (SKIP_DIRS.has(dirent.name) || dirent.name.startsWith('.')) continue;
      const full = path.join(real, dirent.name);
      try {
        const target = realpathSync(full);
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

async function readJsonBody(req, limitBytes = 262_144) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new PoolError('REQUEST_TOO_LARGE', 'İstek boyutu sınırı aşıldı.');
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
  const requestPool = async (routePath, { method = 'GET', body, auth = true, timeoutMs = 15_000 } = {}) => {
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
      signal: AbortSignal.timeout(timeoutMs),
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
    poolModels: group => requestPool(`/api/pools/${encodeURIComponent(group)}?limit=40`, { auth: true }),
    catalogModels: async () => {
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
    liveQuota: routeId => requestPool(`/api/quotas/${encodeURIComponent(routeId)}?live=1`, { auth: true, timeoutMs: 45_000 }),
    connections: () => requestPool('/api/connections', { auth: true }),
    tasks: (limit = 50) => requestPool(`/api/tasks?limit=${limit}`, { auth: true }),
    task: (id, compact = false) => requestPool(`/api/tasks/${encodeURIComponent(id)}?compact=${compact ? '1' : '0'}`, { auth: true }),
    submit: payload => requestPool('/api/tasks', { method: 'POST', body: payload, auth: true, timeoutMs: 30_000 }),
    cancel: id => requestPool(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {}, auth: true }),
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
} = {}) {
  const remoteStore = store || new RemoteStore(directory);
  const pool = poolBridge || createPoolBridge(directory);
  const tailscaleIp = detectTailscaleIp();
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
  const hostAllowed = (reqHost, listenPort) => {
    if (!reqHost) return false;
    const lower = String(reqHost).toLowerCase();
    if (lower === `127.0.0.1:${listenPort}` || lower === `localhost:${listenPort}`) return true;
    if (tailscaleIp && lower === `${tailscaleIp}:${listenPort}`) return true;
    if (host && host !== '0.0.0.0' && host !== 'tailscale' && lower === `${host.toLowerCase()}:${listenPort}`) return true;
    if (host === '0.0.0.0') return true;
    if (allowedHostSet.has(lower) || allowedHostSet.has(lower.split(':')[0])) return true;
    // Allow Tailscale MagicDNS (*.ts.net) when tailscale mode or explicit host is active
    if (host === 'tailscale' && /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(?::\d+)?$/.test(lower)) return true;
    return false;
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

  const handler = async (req, res) => {
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
      const remoteAddr = req.socket?.remoteAddress || '';
      const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
      if (!isLoopback || req.headers.host !== `127.0.0.1:${actualPort}` || 'origin' in req.headers || 'sec-fetch-site' in req.headers) {
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
        const created = createPairingCode(body.label || 'Bilgisayar');
        const localUrl = `http://127.0.0.1:${actualPort}/?pair=${created.code}`;
        const tailscaleUrl = tailscaleIp && bindTargets.includes(tailscaleIp)
          ? `http://${tailscaleIp}:${actualPort}/?pair=${created.code}`
          : null;
        return sendJson(res, 200, {
          dashboard: localUrl,
          localUrl,
          tailscaleUrl,
          port: actualPort,
          tailscaleIp,
          bindTargets,
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
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
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
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
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
      prunePairings();
      let code = '';
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      let raw = '';
      for await (const chunk of req) {
        raw += chunk.toString('utf8');
        if (raw.length > 4096) return sendJson(res, 413, { error: { code: 'REQUEST_TOO_LARGE', message: 'İstek çok büyük.' } });
      }
      if (ct.includes('application/json')) {
        try { code = String(JSON.parse(raw).code || ''); } catch { code = ''; }
      } else {
        code = new URLSearchParams(raw).get('code') || '';
      }
      const pending = pendingPairings.get(code);
      if (!pending) {
        if (ct.includes('application/json')) return sendJson(res, 401, { error: { code: 'INVALID_PAIR_CODE', message: 'Eşleştirme kodu geçersiz veya daha önce kullanılmış.' } });
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(unauthHtml);
      }
      pendingPairings.delete(code);
      const ua = String(req.headers['user-agent'] || '');
      const deviceHint = /android/i.test(ua) ? 'Android Telefon' : /iphone|ipad/i.test(ua) ? 'iPhone / iPad' : pending.label || 'Tarayıcı';
      const paired = remoteStore.pairDevice(deviceHint);
      const isHttps = req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket?.encrypted);
      const cookie = `pool_remote=${paired.cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${isHttps ? '; Secure' : ''}`;
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
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(unauthHtml);
    }

    // Authenticated static assets
    if (req.method === 'GET' && staticFiles.has(pathname)) {
      const [type, read] = staticFiles.get(pathname);
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      });
      return res.end(read());
    }

    // SSE live task stream: GET /r/stream?taskId=...&chatId=...
    if (req.method === 'GET' && pathname === '/r/stream') {
      const taskId = url.searchParams.get('taskId') || '';
      const chatId = url.searchParams.get('chatId') || '';
      if (!taskId) return sendJson(res, 400, { error: { code: 'INVALID_REQUEST', message: 'taskId gerekli.' } });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      let closed = false;
      req.once('close', () => { closed = true; });
      let lastStamp = '';
      const push = (event, data) => {
        if (closed || res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const loop = async () => {
        for (let tick = 0; tick < 3600 && !closed; tick++) {
          try {
            const task = await pool.task(taskId, false);
            const stamp = `${task.state}:${task.updated}:${(task.events || []).length}:${(task.result || '').length}:${task.error || ''}`;
            if (stamp !== lastStamp) {
              lastStamp = stamp;
              if (chatId) {
                remoteStore.updateTaskMessage(chatId, taskId, {
                  state: task.state,
                  result: task.result || '',
                  error: task.error || null,
                  errorDetail: task.errorDetail || '',
                  report: task.report || null,
                  reportedModel: task.reportedModel || null,
                  events: (task.events || []).slice(-30),
                });
              }
              push('update', { task });
            }
            if (TERMINAL_STATES.has(task.state)) {
              push('done', { task });
              break;
            }
          } catch (err) {
            push('error', { message: err instanceof PoolError ? err.message : 'Görev durumu okunamadı.' });
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 800));
        }
        if (!res.writableEnded) res.end();
      };
      void loop();
      return;
    }

    try {
      // GET /r/state — Full live dashboard snapshot
      if (req.method === 'GET' && pathname === '/r/state') {
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
          if (pools.length && typeof pool.poolModels === 'function') {
            const perPool = await Promise.allSettled(pools.map(p => pool.poolModels(p.id)));
            pools = pools.map((p, idx) => ({
              ...p,
              models: perPool[idx]?.status === 'fulfilled' ? (perPool[idx].value?.models || []) : [],
            }));
          }
        }
        const cfg = pool.getConfig();
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
          favoriteFolders: remoteStore.state.favoriteFolders,
          recentFolders: remoteStore.state.recentFolders,
          workspaceRoots: cfg.workspaceRoots || [],
          devices: remoteStore.listDevices(),
          tailscaleIp,
          port: actualPort,
          hostMode: host,
        });
      }

      // GET /r/dirs?path=...
      if (req.method === 'GET' && pathname === '/r/dirs') {
        const cfg = pool.getConfig();
        const result = listDirectoriesSafe(url.searchParams.get('path') || '', cfg.workspaceRoots || []);
        return sendJson(res, 200, result);
      }

      // POST /r/folders/favorite
      if (req.method === 'POST' && pathname === '/r/folders/favorite') {
        const body = await readJsonBody(req);
        const cfg = pool.getConfig();
        const checked = listDirectoriesSafe(body.path || '', cfg.workspaceRoots || []);
        const favoriteFolders = remoteStore.toggleFavoriteFolder(checked.current);
        return sendJson(res, 200, { favoriteFolders });
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
                remoteStore.updateTaskMessage(chatId, msg.taskId, {
                  state: live.state,
                  result: live.result || '',
                  error: live.error || null,
                  errorDetail: live.errorDetail || '',
                  report: live.report || null,
                  reportedModel: live.reportedModel || null,
                  events: (live.events || []).slice(-30),
                });
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
          if (!rawPrompt) throw new PoolError('INVALID_REQUEST', 'Gönderilecek mesaj boş olamaz.');
          const workspace = String(body.workspace || chat.workspace || '').trim();
          if (!workspace) throw new PoolError('INVALID_REQUEST', 'Önce bir çalışma klasörü seçin.');
          const cfg = pool.getConfig();
          const checkedDir = listDirectoriesSafe(workspace, cfg.workspaceRoots || []);
          const canonicalWorkspace = cfg.workspaceRoots?.length ? allowedWorkspace(checkedDir.current, cfg.workspaceRoots) : checkedDir.current;
          remoteStore.updateChat(chatId, { workspace: canonicalWorkspace });

          const kind = ['text', 'read', 'write'].includes(body.kind) ? body.kind : 'read';
          const mode = kind === 'write' ? (body.mode === 'response' ? 'response' : 'execute') : 'response';
          const includeContext = body.includeContext !== false;
          const finalPrompt = buildCompactPrompt(chat, rawPrompt, includeContext);

          const taskReq = {
            prompt: finalPrompt,
            workspace: canonicalWorkspace,
            kind,
            mode,
            ...(body.group ? { group: String(body.group) } : {}),
            ...(body.routeId ? { routeId: String(body.routeId) } : {}),
            ...(body.modelId ? { modelId: String(body.modelId) } : {}),
            ...(body.effort ? { effort: String(body.effort) } : {}),
            timeoutSeconds: Number.isInteger(body.timeoutSeconds) ? body.timeoutSeconds : 600,
            clientLabel: `Remote (${device.label})`,
            idempotencyKey: `remote-${randomUUID()}`,
          };

          const submitted = await pool.submit(taskReq);
          const userMsg = remoteStore.appendMessage(chatId, {
            role: 'user',
            text: rawPrompt,
            workspace: canonicalWorkspace,
            kind,
            mode,
            includeContext,
          });
          const assistantMsg = remoteStore.appendMessage(chatId, {
            role: 'assistant',
            text: '',
            taskId: submitted.id,
            routeId: submitted.routeId,
            modelId: submitted.modelId,
            group: submitted.group || body.group || null,
            effort: submitted.effort || body.effort || null,
            kind,
            mode,
            state: submitted.state || 'queued',
            result: submitted.result || '',
            error: submitted.error || null,
            errorDetail: submitted.errorDetail || '',
            report: submitted.report || null,
            events: [],
          });
          return sendJson(res, 200, {
            chat: remoteStore.getChat(chatId),
            userMessage: userMsg,
            assistantMessage: assistantMsg,
            task: submitted,
          });
        }
      }

      // Tasks direct inspect & cancel
      const taskMatch = /^\/r\/tasks\/([a-zA-Z0-9-]+)(?:\/(cancel))?$/.exec(pathname);
      if (taskMatch) {
        const [, taskId, sub] = taskMatch;
        if (req.method === 'GET' && !sub) {
          return sendJson(res, 200, { task: await pool.task(taskId, false) });
        }
        if (req.method === 'POST' && sub === 'cancel') {
          return sendJson(res, 200, { task: await pool.cancel(taskId) });
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
        await Promise.allSettled((conns || []).map(c => pool.liveQuota(c.id)));
        return sendJson(res, 200, { quotas: await pool.quotas() });
      }

      // Pairing & device management
      if (req.method === 'POST' && pathname === '/r/pair') {
        const body = await readJsonBody(req);
        const created = createPairingCode(body.label || 'Telefon');
        const preferredHost = body.useTailscale !== false && tailscaleIp ? `${tailscaleIp}:${actualPort}` : req.headers.host;
        const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
        const pairUrl = `${proto}://${preferredHost}/?pair=${created.code}`;
        return sendJson(res, 200, {
          ...created,
          url: pairUrl,
          localUrl: `http://127.0.0.1:${actualPort}/?pair=${created.code}`,
          tailscaleIp,
          qrSvg: qrSvg(pairUrl),
        });
      }
      if (req.method === 'GET' && pathname === '/r/devices') {
        return sendJson(res, 200, { devices: remoteStore.listDevices(), currentDeviceId: device.id });
      }
      if (req.method === 'POST' && pathname === '/r/devices/revoke') {
        const body = await readJsonBody(req);
        const removed = remoteStore.revokeDevice(body.deviceId);
        return sendJson(res, 200, { revoked: removed, devices: remoteStore.listDevices() });
      }

      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Uç nokta bulunamadı.' } });
    } catch (error) {
      const code = error instanceof PoolError ? error.code : 'INTERNAL_ERROR';
      const status = code === 'INVALID_REQUEST' || code === 'INVALID_JSON' || code === 'INVALID_WORKSPACE' ? 400
        : code === 'WORKSPACE_DENIED' || code === 'HOST_DENIED' ? 403
        : code === 'NOT_FOUND' ? 404
        : code === 'REQUEST_TOO_LARGE' ? 413
        : code === 'INTERNAL_ERROR' ? 500 : 409;
      return sendJson(res, status, { error: { code, message: error instanceof PoolError ? error.message : 'İşlem tamamlanamadı.' } });
    }
  };

  const servers = [];
  const bindTargets = host === 'tailscale'
    ? (tailscaleIp ? ['127.0.0.1', tailscaleIp] : ['127.0.0.1'])
    : [host];
  const closeAll = async () => {
    await Promise.all(servers.map(s => new Promise(resolve => {
      try { s.closeAllConnections?.(); } catch { /* ignore */ }
      s.close(() => resolve());
    })));
    servers.length = 0;
  };

  return {
    store: remoteStore,
    tailscaleIp,
    bindTargets,
    initialPairingCode: initialPairing.code,
    createPairingCode,
    async listen() {
      let boundPort = port;
      for (const bindHost of bindTargets) {
        const srv = http.createServer((req, res) => { void handler(req, res); });
        await new Promise((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(boundPort, bindHost, () => {
            srv.off('error', reject);
            boundPort = srv.address().port;
            resolve();
          });
        });
        servers.push(srv);
      }
      const localUrl = `http://127.0.0.1:${boundPort}/?pair=${initialPairing.code}`;
      const tailscaleUrl = tailscaleIp && bindTargets.includes(tailscaleIp)
        ? `http://${tailscaleIp}:${boundPort}/?pair=${initialPairing.code}`
        : null;
      return { port: boundPort, bindTargets, tailscaleIp, localUrl, tailscaleUrl };
    },
    close: closeAll,
  };
}
