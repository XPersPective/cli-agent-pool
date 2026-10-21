// Native vendor quota readers. Credentials are read from the official CLI's own
// local store, kept in memory for one request and never written or returned.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 10_000;

export function readJson(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  try {
    const response = await fetch(url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* keep text */ }
    return { status: response.status, data };
  } catch { return { status: 0, data: null }; }
}

const percent = value => {
  const number = typeof value === 'string' ? Number.parseFloat(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
};
const isoTime = value => {
  if (value == null || value === '') return null;
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const unknown = (source, note, extra = {}) => ({ status: 'unknown', windows: [], source, ...(note ? { note } : {}), ...extra });
const authRequired = (source, note) => ({ status: 'auth_required', auth: 'missing', windows: [], source, ...(note ? { note } : {}) });
// Only a missing credential is proof of logout; expired tokens are refreshed by the CLI itself on its next run.
const withStatus = (windows, extra) => ({ status: !windows.length ? 'unknown' : windows.some(window => window.remainingPercent <= 0) ? 'rate_limited' : 'available', scope: 'account', windows, ...extra });

// ---- Claude (claude.ai subscription) -------------------------------------
export function claudeWindows(usage) {
  return [['five_hour', 300], ['seven_day', 10080], ['seven_day_opus', 10080, 'opus'], ['seven_day_sonnet', 10080, 'sonnet']].flatMap(([key, minutes, family]) => {
    const used = percent(usage?.[key]?.utilization);
    if (used == null) return [];
    return [{ name: family ? `${family}:7d` : key, remainingPercent: 100 - used, resetsAt: isoTime(usage[key].resets_at), windowMinutes: minutes, ...(family ? { models: [family] } : {}) }];
  });
}

export async function claudeQuota(home = homedir()) {
  const oauth = readJson(path.join(home, '.claude', '.credentials.json')).claudeAiOauth;
  const live = oauth?.accessToken && (!oauth.expiresAt || oauth.expiresAt > Date.now() + 60_000);
  if (live) {
    const { status, data } = await request('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' } });
    if (status === 200) return withStatus(claudeWindows(data), { auth: oauth.subscriptionType || 'claude.ai', source: 'anthropic-oauth-usage', ...(oauth.subscriptionType ? { note: `Plan: ${oauth.subscriptionType}` } : {}) });
  }
  // Claude Code stores the last server snapshot itself; use it only while fresh.
  const cached = readJson(path.join(home, '.claude.json')).cachedUsageUtilization;
  const age = Date.now() - Number(cached?.fetchedAtMs);
  if (cached?.utilization && age >= 0 && age < 30 * 60_000) {
    const windows = claudeWindows(cached.utilization);
    if (windows.length) return withStatus(windows, { source: 'claude-code-cache', observedAt: new Date(cached.fetchedAtMs).toISOString() });
  }
  return oauth?.accessToken ? unknown('anthropic-oauth-usage', live ? 'Claude kota servisi şu an yanıt vermedi (oran sınırı olabilir).' : 'Claude oturum jetonu yenilenmeyi bekliyor; CLI bir sonraki çalıştırmada yeniler.', { auth: 'credentials_present' }) : authRequired('anthropic-oauth-usage');
}

// ---- Z.AI GLM Coding Plan (ZCode) ----------------------------------------
// ponytail: unit codes observed from the monitor API (3=hour, 6=week, 5=month); add more if Z.AI documents them.
const zaiUnitMinutes = { 3: 60, 5: 43_200, 6: 10_080 };
export function zaiWindows(body) {
  return (body?.data?.limits || []).flatMap(limit => {
    if (limit?.type !== 'TOKENS_LIMIT') return [];
    const used = percent(limit.percentage);
    if (used == null) return [];
    const minutes = zaiUnitMinutes[limit.unit] ? zaiUnitMinutes[limit.unit] * (Number(limit.number) || 1) : null;
    return [{ name: minutes ? `tokens:${minutes}m` : `tokens:${limit.unit}:${limit.number}`, remainingPercent: 100 - used, resetsAt: isoTime(limit.nextResetTime), ...(minutes ? { windowMinutes: minutes } : {}) }];
  });
}

// The key the ZCode CLI really sends (provider_config) wins over the legacy desktop entry.
export function zaiKeys(home = homedir()) {
  const base = path.join(home, '.zcode', 'v2');
  const personal = readJson(path.join(base, 'provider_config.json')).config?.providerConfigRules?.providerRules || [];
  const cliKey = personal.find(rule => rule?.providerId === 'zai-api' && rule.enabled !== false)?.config?.access?.apiKey;
  const legacy = readJson(path.join(base, 'config.json')).provider?.['builtin:zai-coding-plan'];
  const legacyKey = legacy?.enabled !== false && /^https:\/\/api\.z\.ai\//.test(legacy?.options?.baseURL || '') ? legacy.options.apiKey : null;
  return [...new Set([cliKey, legacyKey].filter(key => typeof key === 'string' && key.trim()))];
}

const zaiMonitor = (key, origin = 'https://api.z.ai') => request(`${origin}/api/monitor/usage/quota/limit`, { headers: { Authorization: key } });

export async function zaiQuota(home = homedir()) {
  const keys = zaiKeys(home);
  if (!keys.length) return authRequired('zai-monitor', 'ZCode içinde Z.AI Coding Plan anahtarı yok; zcode login zai çalıştırın.');
  for (const [index, key] of keys.entries()) {
    const { status, data } = await zaiMonitor(key);
    if (status === 200 && data?.success) {
      const note = `Plan: ${data.data?.level || 'bilinmiyor'}${index ? ' · Uyarı: ZCode CLI anahtarında plan yok, masaüstü anahtarı ölçüldü' : ''}`;
      return withStatus(zaiWindows(data), { auth: `zai (${data.data?.level || 'plan'})`, source: 'zai-monitor', note, ...(index ? { status: 'auth_required' } : {}) });
    }
  }
  return { status: 'auth_required', auth: 'no_plan', windows: [], source: 'zai-monitor', note: 'Z.AI anahtarı bir Coding Plan paketine bağlı değil.' };
}

// ---- Google Antigravity ----------------------------------------------------
const ANTIGRAVITY_CLIENT = { id: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com', secret: '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' };
const ANTIGRAVITY_ENDPOINTS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'];
const credentialScript = fileURLToPath(new URL('./wincred.ps1', import.meta.url));

function windowsCredential(target) {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', credentialScript, '-Target', target], { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 65_536 }, (error, stdout) => resolve(error ? null : stdout));
  });
}

async function antigravityToken(home) {
  let stored = readJson(path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'));
  if (!stored.token && process.platform === 'win32') {
    try { stored = JSON.parse(await windowsCredential('gemini:antigravity') || '{}'); } catch { stored = {}; }
  }
  const token = stored.token || {};
  if (token.access_token && Date.parse(token.expiry) > Date.now() + 60_000) return token.access_token;
  if (!token.refresh_token) return null;
  // Refresh in memory only; the CLI keeps owning its stored credential.
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: ANTIGRAVITY_CLIENT.id, client_secret: ANTIGRAVITY_CLIENT.secret, refresh_token: token.refresh_token, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    return response.ok ? (await response.json()).access_token || null : null;
  } catch { return null; }
}

export function antigravityModelWindows(body) {
  const rows = Array.isArray(body?.models) ? body.models.map(model => [model?.name || model?.id, model]) : Object.entries(body?.models || {});
  const byModel = new Map();
  for (const [name, model] of rows) {
    const fraction = model?.quotaInfo?.remainingFraction;
    if (typeof name !== 'string' || typeof fraction !== 'number' || /^(tab|chat)_/.test(name)) continue; // internal IDE features, not models
    const id = name.replace(/-(low|medium|high|xhigh|max)$/, '');
    const window = { name: id, remainingPercent: percent(fraction * 100), resetsAt: isoTime(model.quotaInfo.resetTime), models: [id] };
    if (!byModel.has(id) || byModel.get(id).remainingPercent > window.remainingPercent) byModel.set(id, window);
  }
  return [...byModel.values()];
}

export function antigravityGroupWindows(body) {
  return (body?.groups || []).flatMap(group => {
    const label = `${group.displayName || group.name || ''} ${group.description || ''}`.toLowerCase();
    const explicit = [...label.matchAll(/gemini\s+(flash|pro)|\b(argon|claude|opus|sonnet|haiku|gpt)\b/g)].map(match => match[1] ? `gemini-${match[1]}` : match[2]);
    const models = [...new Set(explicit.length ? explicit : label.match(/gemini|claude|gpt/g) || [])];
    return (group.buckets || []).flatMap(bucket => {
      const remaining = typeof bucket?.remainingFraction === 'number' ? percent(bucket.remainingFraction * 100) : null;
      if (remaining == null) return [];
      const minutes = bucket.window === '5h' ? 300 : bucket.window === 'weekly' ? 10_080 : null;
      return [{ name: `${group.displayName || group.name || 'grup'}:${bucket.window || 'pencere'}`, remainingPercent: remaining, resetsAt: isoTime(bucket.resetTime), ...(minutes ? { windowMinutes: minutes } : {}), ...(models.length ? { models } : {}) }];
    });
  });
}

export async function antigravityQuota(home = homedir()) {
  const token = await antigravityToken(home);
  if (!token) return authRequired('antigravity-cloudcode', 'Antigravity oturumu bulunamadı; agy çalıştırıp giriş yapın.');
  const headers = agent => ({ Authorization: `Bearer ${token}`, 'User-Agent': agent });
  for (const base of ANTIGRAVITY_ENDPOINTS) {
    const load = await request(`${base}/v1internal:loadCodeAssist`, { method: 'POST', headers: headers('antigravity/windows/amd64'), body: { metadata: { ideType: 'ANTIGRAVITY' } } });
    if (load.status === 401) return unknown('antigravity-cloudcode', 'Antigravity oturumu yenilenemedi; agy ile tekrar giriş gerekebilir.');
    const project = typeof load.data?.cloudaicompanionProject === 'string' ? load.data.cloudaicompanionProject : load.data?.cloudaicompanionProject?.id;
    if (load.status !== 200 || !project) continue;
    const tier = load.data.currentTier?.id || load.data.paidTier?.id || 'free';
    const [models, summary] = await Promise.all([
      request(`${base}/v1internal:fetchAvailableModels`, { method: 'POST', headers: headers('antigravity/1.11.5 windows/amd64'), body: { project } }),
      request(`${base}/v1internal:retrieveUserQuotaSummary`, { method: 'POST', headers: headers('antigravity/hub/2.9.1 windows/amd64'), body: { project } }),
    ]);
    const groups = summary.status === 200 ? antigravityGroupWindows(summary.data) : [];
    const perModel = models.status === 200 ? antigravityModelWindows(models.data) : [];
    // Group windows are the provider's routing limits; per-model rows fill only uncovered models.
    const covered = id => groups.some(window => window.models?.some(scope => scope.startsWith('gemini-') ? id.includes('gemini') && id.includes(scope.slice(7)) : id.includes(scope)));
    const windows = [...groups, ...perModel.filter(window => !covered(window.name))];
    if (windows.length) return { ...withStatus(windows, { auth: tier, source: 'antigravity-cloudcode', note: `Plan: ${tier}` }), scope: 'model' };
  }
  return unknown('antigravity-cloudcode', 'Antigravity kota servisi yanıt vermedi.');
}

// ---- Kimi Code -----------------------------------------------------------
export function kimiWindows(body) {
  const windows = Object.entries(body?.usages || {}).flatMap(([name, entry]) => {
    const used = Number(entry?.used_ratio);
    return Number.isFinite(used) ? [{ name, remainingPercent: percent(100 - used * 100), resetsAt: isoTime(entry.reset_time) }] : [];
  });
  if (windows.length) return windows;
  const entries = [...(body?.usage ? [['subscription', body.usage]] : []), ...(body?.limits || []).map((item, index) => [`limit_${index}`, item?.detail])];
  return entries.flatMap(([name, entry]) => {
    const limit = Number(entry?.limit), remaining = Number(entry?.remaining);
    return limit > 0 && Number.isFinite(remaining) ? [{ name, remainingPercent: percent(remaining / limit * 100), resetsAt: isoTime(entry.resetTime) }] : [];
  });
}

export async function kimiQuota(home = homedir()) {
  let toml = '';
  try { toml = readFileSync(path.join(home, '.kimi-code', 'config.toml'), 'utf8'); } catch { /* not configured */ }
  const section = /^\[providers\."managed:kimi-code"\.oauth\]\s*\n([^[]*)/m.exec(toml)?.[1] || '';
  const key = /^\s*key\s*=\s*"oauth\/([A-Za-z0-9_-]+)"\s*$/m.exec(section)?.[1];
  const creds = key ? readJson(path.join(home, '.kimi-code', 'credentials', `${key}.json`)) : {};
  if (typeof creds.access_token !== 'string') return authRequired('kimi-code-usage');
  if (Number(creds.expires_at) && Number(creds.expires_at) * 1000 <= Date.now()) return unknown('kimi-code-usage', 'Kimi oturum jetonu süresi dolmuş; CLI yenileyemezse kimi login --region global çalıştırın.', { auth: 'credentials_present' });
  const { status, data } = await request('https://api.kimi.ai/coding/v1/usages', { headers: { Authorization: `Bearer ${creds.access_token}` } });
  if (status === 401) return unknown('kimi-code-usage', 'Kimi oturum jetonu reddedildi.', { auth: 'credentials_present' });
  if (status === 403) return { status: 'auth_required', auth: 'no_subscription', windows: [], source: 'kimi-code-usage', note: 'Kimi aboneliği Kimi Code erişimi içermiyor.' };
  if (status !== 200) return unknown('kimi-code-usage', `Kimi kota servisi HTTP ${status}`);
  const windows = kimiWindows(data);
  return withStatus(windows, { auth: 'kimi-code', source: 'kimi-code-usage', ...(windows.length ? {} : { note: 'Kimi Code kullanım kotası boş döndü; abonelik Kimi Code içermiyor olabilir.' }) });
}

// ---- MiniMax Code ----------------------------------------------------------
export function minimaxWindows(body) {
  return (body?.model_remains || []).flatMap((model, index) => [['current_interval', '5h', 'end_time', 300], ['current_weekly', '7d', 'weekly_end_time', 10_080]].flatMap(([prefix, label, reset, minutes]) => {
    if (model[`${prefix}_status`] === 3) return []; // unlimited
    let remaining = percent(model[`${prefix}_remaining_percent`]);
    const total = Number(model[`${prefix}_total_count`]);
    if (remaining == null && total > 0) remaining = percent(Number(model[`${prefix}_usage_count`]) / total * 100); // client treats usage_count as remaining
    return remaining == null ? [] : [{ name: `${model.model_name || `model_${index}`}:${label}`, remainingPercent: remaining, resetsAt: isoTime(model[reset]), windowMinutes: minutes }];
  }));
}

export async function minimaxQuota(home = homedir()) {
  const creds = readJson(path.join(home, '.minimax', 'local-runtime.auth.json')).auth;
  if (!creds?.accessToken) return authRequired('minimax-coding-plan', 'mcode login --region global ile giriş yapın.');
  const md5 = value => createHash('md5').update(value).digest('hex');
  const now = new Date(), millis = String(now.getTime()), seconds = String(Math.floor(now.getTime() / 1000));
  const query = new URLSearchParams({ device_platform: 'mcode', biz_id: '3', app_id: '3001', version_code: '22201', unix: millis, timezone_offset: String(-now.getTimezoneOffset() * 60), sys_language: 'en', lang: 'en', device_id: '0', os_name: process.platform === 'win32' ? 'win32' : 'linux', browser_name: 'mcode', user_id: creds.realUserID || '0', client: 'mcode' });
  const route = `/matrix/api/v1/user/get_user_extra_info?${query}`;
  const encoded = encodeURIComponent(route); // same safe set as the client's Python quote(safe="~()*!.'-")
  const lookup = await request(`https://agent.minimax.io${route}`, { method: 'POST', body: {}, headers: { Authorization: `Bearer ${creds.accessToken}`, 'User-Agent': 'MiniMaxCode', 'x-timestamp': seconds, yy: md5(`${encoded}_{}${md5(millis)}ooui`), 'x-signature': md5(`${seconds}I*7Cf%WZ#S&%1RlZJ&C2{}`) } });
  const workspaces = lookup.data?.workspaces || lookup.data?.data?.workspaces || [];
  const group = workspaces.find(workspace => workspace?.workspace_type === 0)?.op_group_id;
  if (!group) return unknown('minimax-coding-plan', 'MiniMax girişi var; plan kotası okunamadı.', { auth: 'credentials_present' });
  const { status, data } = await request('https://platform.minimax.io/v1/api/openplatform/coding_plan/remains', { headers: { Authorization: `Bearer ${creds.accessToken}`, 'X-Group-Id': String(group) } });
  if (status !== 200 || data?.base_resp?.status_code) return unknown('minimax-coding-plan', 'MiniMax plan kotası okunamadı.', { auth: 'credentials_present' });
  const windows = minimaxWindows(data);
  return windows.length ? withStatus(windows, { auth: 'minimax', source: 'minimax-coding-plan' }) : { status: 'unknown', auth: 'minimax', windows: [], subscription: 'none', source: 'minimax-coding-plan', note: 'Etkin MiniMax Coding Plan bulunamadı.' };
}

// ---- OpenRouter (through OpenCode's own auth store) -------------------------
export function openrouterKey(home = homedir()) {
  const base = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const entry = readJson(path.join(base, 'opencode', 'auth.json')).openrouter;
  return entry?.type === 'api' && typeof entry.key === 'string' && entry.key.trim() ? entry.key : null;
}

export function openrouterNote(key, credits) {
  const parts = [];
  if (credits) parts.push(`OpenRouter bakiye: $${(Number(credits.total_credits) - Number(credits.total_usage)).toFixed(2)}`);
  if (key) {
    if (key.limit != null) parts.push(`anahtar limiti kalan: $${Number(key.limit_remaining).toFixed(2)}`);
    // OpenRouter documents 50 free-model requests/day below 10 purchased credits, 1000 above.
    parts.push(`ücretsiz modeller: günlük ${Number(credits?.total_credits) >= 10 ? 1000 : 50} istek`);
  }
  return parts.join(' · ');
}

export async function openrouterQuota(home = homedir()) {
  const key = openrouterKey(home);
  return key ? openrouterInfo(key) : null;
}

async function openrouterInfo(key) {
  const headers = { Authorization: `Bearer ${key}` };
  const [info, credits] = await Promise.all([request('https://openrouter.ai/api/v1/key', { headers }), request('https://openrouter.ai/api/v1/credits', { headers })]);
  if (info.status === 401) return { auth: 'missing', note: 'OpenRouter anahtarı geçersiz; opencode providers login ile yenileyin.' };
  const balance = credits.status === 200 ? Number(credits.data?.data?.total_credits) - Number(credits.data?.data?.total_usage) : null;
  return { auth: 'api_key', note: openrouterNote(info.status === 200 ? info.data?.data : null, credits.status === 200 ? credits.data?.data : null), ...(Number.isFinite(balance) ? { balanceUsd: balance } : {}) };
}

// ---- User-added API / token-plan routes ------------------------------------
// Only vendors with a documented key-based usage endpoint are queried; others stay unknown.
export function apiQuotaVendor(baseUrl) {
  let host = '';
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return null; }
  if (host === 'api.z.ai') return 'zai';
  if (host === 'open.bigmodel.cn') return 'bigmodel';
  if (host === 'openrouter.ai') return 'openrouter';
  if (/(^|\.)minimax\.io$|(^|\.)minimaxi\.com$/.test(host)) return 'minimax';
  return null;
}

export async function apiRouteQuota(baseUrl, key) {
  const vendor = apiQuotaVendor(baseUrl);
  if (!vendor || !key) return null;
  if (vendor === 'openrouter') {
    const info = await openrouterInfo(key);
    return { ...info, status: info.auth === 'missing' ? 'auth_required' : 'available', windows: [], source: 'openrouter-key' };
  }
  if (vendor === 'zai' || vendor === 'bigmodel') {
    const { status, data } = await zaiMonitor(key, vendor === 'zai' ? 'https://api.z.ai' : 'https://open.bigmodel.cn');
    if (status === 200 && data?.success) return withStatus(zaiWindows(data), { source: `${vendor}-monitor`, note: `Plan: ${data.data?.level || 'bilinmiyor'}` });
    return status === 200 ? { status: 'unknown', windows: [], source: `${vendor}-monitor`, note: 'Anahtar bir Coding Plan paketine bağlı değil (kullandıkça öde olabilir).' } : null;
  }
  const origin = new URL(baseUrl).hostname.endsWith('minimaxi.com') ? 'https://www.minimaxi.com' : 'https://platform.minimax.io';
  const { status, data } = await request(`${origin}/v1/api/openplatform/coding_plan/remains`, { headers: { Authorization: `Bearer ${key}` } });
  if (status !== 200 || data?.base_resp?.status_code) return null;
  return withStatus(minimaxWindows(data), { source: 'minimax-coding-plan' });
}
