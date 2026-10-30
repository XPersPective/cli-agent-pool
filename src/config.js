import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, realpathSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';

export class PoolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const label = z.string().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Kontrol karakterleri kullanılamaz.');
export const adapterValues = [
  'codex', 'claude', 'opencode', 'zcode', 'qwen', 'mcode', 'mmx',
  'kimi', 'mimo', 'agy', 'omniroute', 'lmstudio', 'ollama',
  'aider', 'kilocode', 'hermes', 'custom',
];
export const billingModes = ['subscription', 'token_plan', 'free_credits', 'free', 'paid_api', 'unknown'];
export const nonMeteredBillings = new Set(['subscription', 'token_plan', 'free_credits', 'free']);
export const activeBillings = new Set(['subscription', 'token_plan', 'free_credits', 'free', 'paid_api']);

const apiBlockSchema = z.object({
  protocol: z.enum(['anthropic', 'openai']),
  baseUrl: z.string().min(1).max(512).refine(value => {
    try { const parsed = new URL(value); return parsed.protocol === 'https:' || parsed.protocol === 'http:'; }
    catch { return false; }
  }, 'API adresi geçerli bir http/https URL olmalı.'),
  secretRef: label.regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
}).strict();

export const configSchema = z.object({
  port: z.number().int().min(1024).max(65535).default(43127),
  python: z.string().min(1).default(process.platform === 'win32' ? 'python' : 'python3'),
  // Legacy configuration only; local projects require no Pool allowlist.
  workspaceRoots: z.array(z.string().min(1)).max(50).default([]),
  concurrency: z.number().int().min(1).max(32).default(20),
  groupingMode: z.enum(['manual', 'agent']).default('manual'),
  selectionMode: z.enum(['manual', 'auto']).default('auto'),
  modelFilters: z.array(z.object({ match: z.enum(['model', 'family']), value: label, routeId: label.optional() }).strict()).max(500).default([]),
  routes: z.array(z.object({
    id: label.regex(/^[a-zA-Z0-9_-]+$/),
    adapter: z.enum(adapterValues),
    executable: z.string().min(1).refine(value => path.isAbsolute(value), 'CLI yolu mutlak olmalı.'),
    enabled: z.boolean().default(false),
    billing: z.enum(billingModes).default('unknown'),
    autoSelect: z.boolean().optional(),
    trustedSettings: z.boolean().default(false),
    priority: z.number().int().min(0).max(1000).default(100),
    maxConcurrent: z.number().int().min(1).max(32).default(20),
    minRemainingPercent: z.number().min(0).max(100).default(0),
    api: apiBlockSchema.optional(),
    argsTemplate: z.array(z.string().min(1).max(512).refine(v => !/[\u0000]/.test(v), 'NUL karakteri kullanılamaz.')).min(1).max(32).optional(),
    promptStdin: z.boolean().optional(),
    models: z.array(z.object({
      id: label, alias: label, group: label,
      enabled: z.boolean().default(true),
      efforts: z.array(label).max(10).default([]),
      variants: z.record(label, label).optional(),
      defaultEffort: label.optional(),
      memberships: z.array(z.object({ group: z.enum(['high', 'medium', 'low']), effort: label.optional() }).strict()).max(3).optional(),
      kinds: z.array(z.enum(['text', 'read', 'write'])).min(1),
    }).strict()).max(100),
  }).strict()).max(50),
}).strict().superRefine((config, ctx) => {
  if (new Set(config.routes.map(r => r.id)).size !== config.routes.length)
    ctx.addIssue({ code: 'custom', message: 'Bağlantı kimlikleri benzersiz olmalı.' });
  for (const route of config.routes) {
    if (new Set(route.models.map(m => m.id)).size !== route.models.length)
      ctx.addIssue({ code: 'custom', message: 'Bağlantıdaki model kimlikleri benzersiz olmalı.' });
    if (route.adapter === 'mmx' && route.models.some(m => m.kinds.some(k => k !== 'text')))
      ctx.addIssue({ code: 'custom', message: 'mmx yalnızca metin görevi destekler.' });
    if (route.adapter === 'custom' && (!route.argsTemplate || route.argsTemplate.length === 0))
      ctx.addIssue({ code: 'custom', message: 'Özel CLI (custom) bağlantısı için argsTemplate tanımlanmalıdır.' });
    if (route.models.some(m => m.defaultEffort && !m.efforts.includes(m.defaultEffort)))
      ctx.addIssue({ code: 'custom', message: 'Varsayılan efor desteklenen değerlerden biri olmalı.' });
    for (const model of route.models) {
      if (model.variants && (route.adapter !== 'agy' || Object.keys(model.variants).some(effort => !model.efforts.includes(effort))))
        ctx.addIssue({ code: 'custom', message: 'Model varyantları yalnızca Antigravity tarafından bildirilen eforlarla eşleşmeli.' });
      if (model.memberships?.some(member => member.effort && !model.efforts.includes(member.effort)))
        ctx.addIssue({ code: 'custom', message: 'Havuz eforu modelin desteklediği değerlerden biri olmalı.' });
      if (model.memberships && new Set(model.memberships.map(member => member.group)).size !== model.memberships.length)
        ctx.addIssue({ code: 'custom', message: 'Model aynı havuza yalnızca bir kez eklenebilir.' });
    }
    if (route.api) {
      if (route.api.protocol === 'anthropic' && route.adapter !== 'claude')
        ctx.addIssue({ code: 'custom', message: 'Anthropic uyumlu API yuvası claude adaptörünü kullanmalıdır.' });
      if (route.api.protocol === 'openai' && route.adapter !== 'opencode')
        ctx.addIssue({ code: 'custom', message: 'OpenAI uyumlu API yuvası opencode adaptörünü kullanmalıdır.' });
    }
  }
});

export function dataDirectory() {
  if (process.env.CLI_AGENT_POOL_HOME) return process.env.CLI_AGENT_POOL_HOME;
  const locator = path.join(homedir(), '.cli-agent-pool', 'runtime-path');
  if (existsSync(locator)) {
    const directory = readFileSync(locator,'utf8').trim();
    if (!path.isAbsolute(directory)) throw new PoolError('INVALID_RUNTIME_DIRECTORY','Kayitli Pool veri dizini mutlak bir yol olmali.');
    return directory;
  }
  return path.join(process.env.LOCALAPPDATA || path.join(homedir(), '.local', 'share'), 'cli-agent-pool');
}

export function initialize(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new PoolError('UNSAFE_DATA_DIRECTORY', 'Veri klasörü bağlantı olamaz.');
  if (process.platform === 'win32') {
    const sid = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true });
    if (sid.status !== 0 || !/^S-1-[\d-]+$/.test(sid.stdout.trim())) throw new PoolError('ACL_FAILED', 'Yerel veri klasörü izinleri doğrulanamadı.');
    const acl = spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid.stdout.trim()}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' });
    if (acl.status !== 0) throw new PoolError('ACL_FAILED', 'Yerel veri klasörü izinleri ayarlanamadı.');
  }
  const configPath = path.join(directory, 'config.json');
  if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify({ workspaceRoots: [], routes: [] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  for (const name of ['access-token', 'management-token']) {
    const tokenPath = path.join(directory, name);
    if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  }
}

export function loadConfig(directory) {
  try {
    const config = configSchema.parse(JSON.parse(readFileSync(path.join(directory, 'config.json'), 'utf8')));
    return config;
  } catch (error) {
    // Field paths only: values may contain private local paths and are never echoed.
    const fields = error instanceof z.ZodError ? [...new Set(error.issues.map(issue => issue.path.join('.') || '(root)'))].slice(0, 5).join(', ') : error?.code === 'ENOENT' ? 'config.json bulunamadı' : 'JSON söz dizimi';
    throw new PoolError('INVALID_CONFIG', `Yerel config.json geçersiz (${fields}). Ayarları kontrol edin.`);
  }
}

export function configView(directory) {
  const text = readFileSync(path.join(directory, 'config.json'), 'utf8');
  return { config: configSchema.parse(JSON.parse(text)), revision: createHash('sha256').update(text).digest('hex') };
}

export function saveConfig(directory, input, revision) {
  const config = configSchema.parse(input);
  if (configView(directory).revision !== revision) throw new PoolError('CONFIG_CONFLICT', 'Ayarlar başka bir yerde değişti. Yenileyip tekrar kaydedin.');
  const filename = path.join(directory, 'config.json');
  const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(config, null, 2) + '\n');
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, filename);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return config;
}

export function allowedWorkspace(workspace, roots) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || workspace.includes('\0')) throw new PoolError('INVALID_WORKSPACE', 'Mutlak bir çalışma klasörü yolu gerekli.');
  let actual;
  try { actual = realpathSync(workspace); } catch { throw new PoolError('INVALID_WORKSPACE', 'Çalışma klasörü bulunamadı.'); }
  if (!lstatSync(actual).isDirectory()) throw new PoolError('INVALID_WORKSPACE', 'Çalışma yolu bir klasör olmalı.');
  if (roots && !roots.some(root => {
    const relative = path.relative(root, actual);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  })) throw new PoolError('WORKSPACE_DENIED', 'Bu çalışma klasörü izin listesinde değil.');
  return actual;
}

export function overlaps(a, b) {
  const relative = path.relative(a, b);
  const reverse = path.relative(b, a);
  const inside = r => r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r));
  return inside(relative) || inside(reverse);
}

export function redact(text) {
  return String(text).replace(/\b(?:sk-(?:cp-|api-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}/gi, '$1[REDACTED]');
}
