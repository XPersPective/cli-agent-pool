import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { configView, saveConfig, PoolError } from './config.js';
import { discover } from './adapters.js';
import { codexControl } from './codex-control.js';

export function managementOperation(pool, management, body) {
  if (body.operation === 'save') {
    if (body.config?.port !== pool.config.port || body.config?.python !== pool.config.python) throw new PoolError('RESTART_REQUIRED', 'Port veya Python yolunu değiştirmek için servisi durdurup yerel ayarları değiştirin.');
    pool.config = saveConfig(management.directory, body.config, body.revision);
    pool.schedule();
  } else if (body.operation !== 'get') throw new PoolError('INVALID_OPERATION', 'Geçersiz yönetim işlemi.');
  return configView(management.directory);
}

export function browserUI(pool, management) {
  let launchToken = randomBytes(32).toString('hex');
  const cookieSecret = createHmac('sha256', Buffer.from(management.token, 'hex')).update('cli-agent-pool-browser-cookie-v1').digest();
  const assets = new Map([
    ['/', ['text/html; charset=utf-8', readFileSync(new URL('../web/index.html', import.meta.url))]],
    ['/app.js', ['text/javascript; charset=utf-8', readFileSync(new URL('../web/app.js', import.meta.url))]],
    ['/style.css', ['text/css; charset=utf-8', readFileSync(new URL('../web/style.css', import.meta.url))]],
  ]);
  const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const sign = payload => createHmac('sha256', cookieSecret).update(payload).digest('hex');
  return {
    launchURL(port) { return `http://127.0.0.1:${port}/?token=${launchToken}`; },
    authorized(req, port) {
      const cookie = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(`pool_${port}=`));
      if (!cookie) return false;
      const [expires, mac] = cookie.slice(cookie.indexOf('=') + 1).split('.');
      return /^\d{13}$/.test(expires) && Number(expires) > Date.now() && equal(mac, sign(`${port}:${expires}`));
    },
    serve(req, res, port) {
      let url;
      try { url = new URL(req.url, `http://127.0.0.1:${port}`); } catch { return false; }
      if (req.method !== 'GET' || !assets.has(url.pathname)) return false;
      const pairing = url.searchParams.get('token');
      if (url.pathname === '/' && pairing && launchToken && equal(pairing, launchToken)) {
        launchToken = null;
        const expires = String(Date.now() + 8 * 60 * 60 * 1000);
        res.writeHead(303, { Location: '/', 'Set-Cookie': `pool_${port}=${expires}.${sign(`${port}:${expires}`)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end(); return true;
      }
      if (!this.authorized(req, port)) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Yönetim ekranını terminalde yazdırılan tek kullanımlık bağlantıdan açın.'); return true;
      }
      const [type, bytes] = assets.get(url.pathname);
      res.writeHead(200, {
        'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      });
      res.end(bytes); return true;
    },
    async operation(body) {
      const { operation, payload = {} } = body;
      if (operation === 'snapshot') return { connections: pool.config.routes.map(({ id, adapter, enabled, billing }) => ({ id, adapter, enabled, billing })), models: pool.models(), tasks: pool.list(50), installed: discover(), workspaceRoots: pool.config.workspaceRoots };
      if (operation === 'settings') return managementOperation(pool, management, { operation: 'get' });
      if (operation === 'save') return managementOperation(pool, management, { ...payload, operation: 'save' });
      if (operation === 'submit') return pool.submit(payload);
      if (operation === 'task') return pool.get(payload.taskId);
      if (operation === 'cancel') return pool.cancel(payload.taskId);
      if (operation === 'quota') return pool.getQuota(payload.routeId);
      if (operation === 'catalog') {
        const route = pool.config.routes.find(r => r.id === payload.routeId);
        if (!route || route.adapter !== 'codex' || !pool.config.workspaceRoots[0]) throw new PoolError('UNSUPPORTED_DISCOVERY', 'Canlı keşif için Codex bağlantısı ve izinli çalışma klasörü gerekli.');
        return codexControl(route, pool.config.workspaceRoots[0], pool.config.python, 'models');
      }
      throw new PoolError('INVALID_OPERATION', 'Geçersiz panel işlemi.');
    },
  };
}
