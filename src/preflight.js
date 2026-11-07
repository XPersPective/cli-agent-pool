// Director preflight: harmless probes, verified by Pool rather than by the
// model's own report, cached per route/workspace/capabilities and native
// settings. See docs/director-tasks.md §2.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { PoolError, allowedWorkspace } from './config.js';
import { runProcess } from './process.js';
import { nativeSettingsFiles, settingsDigest } from './native-settings.js';
import { agyProjectMatches } from './agy-project.js';
import { profileHome } from './profiles.js';
import { commandArgv } from './adapters.js';
import { version } from './version.js';

export const CAPABILITIES = ['shell', 'poolMcp', 'readOutside', 'gitCommit', 'gitRemote', 'poolService'];
export const DIRECTOR_ADAPTERS = new Set(['claude', 'codex', 'agy']);
export const PREFLIGHT_MAX_AGE_MS = 7 * 86400_000;
export const PREFLIGHT_RETRY_MS = 30 * 60_000;
export const PREFLIGHT_TIMEOUT_SECONDS = 900;
const SHELL_STEPS = ['shell-a', 'shell-b', 'shell-c'];

export const defaultReadRoots = () => [path.join(homedir(), '.skills-manager', 'skills')];

export function assertDirectorRoute(route) {
  if (!route) throw new PoolError('NOT_FOUND', 'Bağlantı bulunamadı.');
  if (!DIRECTOR_ADAPTERS.has(route.adapter) || route.api || route.argsTemplate?.length)
    throw new PoolError('PROFILE_UNSUPPORTED', `Director tasks support the official claude, codex and agy CLIs; route ${route.id} (${route.adapter}) cannot run one.`);
  if (route.runtime === 'wsl')
    throw new PoolError('PROFILE_UNSUPPORTED', `Route ${route.id} runs in WSL; directors there cannot reach the Pool service reliably. Use a native route.`);
  if (route.billing === 'paid_api') throw new PoolError('PAID_ROUTE_DENIED', `Route ${route.id} is paid_api; directors and relays use non-metered routes only.`);
}

// Requested read paths must sit under owner-configured roots (config.directorReadRoots).
export function validateReadPaths(readPaths = [], roots = defaultReadRoots()) {
  const real = roots.flatMap(root => { try { return [realpathSync(root)]; } catch { return []; } });
  return [...new Set(readPaths.map(item => {
    let actual;
    try { actual = allowedWorkspace(item); } catch { throw new PoolError('READ_PATH_DENIED', `Read path ${item} must be an existing absolute directory.`); }
    const inside = real.some(root => { const relative = path.relative(root, actual); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); });
    if (!inside) throw new PoolError('READ_PATH_DENIED', `Read path ${item} is outside the owner's directorReadRoots (${roots.join(', ')}).`);
    return actual;
  }))].sort();
}

export function normalizeCapabilities(capabilities) {
  const list = capabilities?.length ? capabilities : CAPABILITIES;
  for (const item of list) if (!CAPABILITIES.includes(item)) throw new PoolError('INVALID_REQUEST', `Unknown capability ${item}.`);
  return [...new Set(list)].sort();
}

async function run(argv, cwd, python, { input = '', env = {}, timeoutMs = 30_000 } = {}) {
  return runProcess({ argv, cwd, python, input, extraEnv: env, timeoutMs, maxBytes: 8_388_608 }).done;
}

const gitEnv = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
export async function gitFacts(workspace, python) {
  const inside = await run(['git', '-C', workspace, 'rev-parse', '--is-inside-work-tree'], workspace, python);
  if (inside.stopReason || inside.code !== 0 || inside.output.trim() !== 'true') return { repository: false, origin: false };
  const origin = await run(['git', '-C', workspace, 'remote', 'get-url', 'origin'], workspace, python);
  return { repository: true, origin: !origin.stopReason && origin.code === 0 && Boolean(origin.output.trim()) };
}

export const remoteDigest = output => createHash('sha256').update(output.split(/\r?\n/).map(line => line.trim()).filter(Boolean).sort().join('\n')).digest('hex');
export async function poolRemoteDigest(workspace, python) {
  const result = await run(['git', '-C', workspace, 'ls-remote', 'origin'], workspace, python, { env: gitEnv, timeoutMs: 60_000 });
  return result.stopReason || result.code !== 0 ? null : remoteDigest(result.output);
}

// The CLI version is part of the cache key: an upgrade must re-run preflight.
const versions = new Map();
export async function cliVersion(route, python) {
  const argv = commandArgv(route);
  let stamp = '';
  try { const info = statSync(route.executable); stamp = `${info.size}:${Math.trunc(info.mtimeMs)}`; } catch { /* WSL or missing */ }
  const cacheKey = `${route.executable}\0${stamp}`;
  const cached = versions.get(cacheKey);
  if (cached && Date.now() - cached.at < 300_000) return cached.value;
  const result = await run([...argv, '--version'], path.dirname(route.executable), python, { timeoutMs: 20_000 }).catch(() => null);
  const value = `${stamp}\0${result && !result.stopReason ? `${result.code}:${result.output.trim().slice(0, 200)}` : 'unavailable'}`;
  versions.set(cacheKey, { value, at: Date.now() });
  return value;
}

export async function preflightKey({ route, modelId, effort, workspace, capabilities, readPaths, directory, python }) {
  const parts = [version, JSON.stringify(route), modelId, effort || '', workspace, capabilities.join(','), readPaths.join('\n'),
    await cliVersion(route, python), settingsDigest(nativeSettingsFiles(route, workspace, directory))];
  return createHash('sha256').update(parts.join('\0\0')).digest('hex');
}

export function cachedUsable(entry, key, now = Date.now()) {
  if (!entry || entry.key !== key) return null;
  const checked = Date.parse(entry.observedAt);
  if (!Number.isFinite(checked) || checked > now || now - checked > PREFLIGHT_MAX_AGE_MS) return null;
  return entry;
}

const forward = value => value.replace(/\\/g, '/');

// Pick a file and a random line long enough not to be guessable.
export function readTarget(directory) {
  const names = (() => { try { return readdirSync(directory).sort(); } catch { return []; } })();
  const ordered = [...names.filter(name => name === 'SKILL.md'), ...names.filter(name => name !== 'SKILL.md')];
  const queue = [...ordered.map(name => path.join(directory, name))];
  for (let seen = 0; queue.length && seen < 200; seen++) {
    const file = queue.shift();
    let info; try { info = lstatSync(file); } catch { continue; }
    if (info.isDirectory()) { try { queue.push(...readdirSync(file).sort().map(name => path.join(file, name))); } catch { /* unreadable */ } continue; }
    if (!info.isFile() || info.size > 1_048_576) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const usable = lines.map((text, index) => ({ text, line: index + 1 })).filter(item => item.text.trim().length >= 8);
    if (!usable.length) continue;
    const pick = usable[randomBytes(4).readUInt32BE() % usable.length];
    return { file, line: pick.line, text: pick.text };
  }
  return null;
}

export function probeDirectory(workspace, taskId) {
  return path.join(workspace, `.cli-agent-pool-preflight-${taskId.slice(0, 8)}`);
}
const expectedFiles = reads => ['probe.mjs', ...SHELL_STEPS.map(step => `${step}.json`), 'commit.json', 'remote.json', 'service.json', ...reads.map((_, index) => `read-${index}.txt`)];

export function createProbe({ taskId, workspace, port, capabilities, readPaths, facts }) {
  const secrets = { shell: randomBytes(32).toString('hex'), commit: randomBytes(32).toString('hex'), service: randomBytes(32).toString('hex') };
  const probe = {
    taskId, workspace, capabilities, facts, secrets,
    dir: probeDirectory(workspace, taskId),
    mcpNonce: randomBytes(32).toString('hex'), serviceNonce: randomBytes(32).toString('hex'),
    reads: readPaths.map(directory => ({ directory, target: readTarget(directory) })),
    acks: new Map(), markers: [], created: false,
  };
  probe.port = port;
  return probe;
}

export function writeProbe(probe) {
  mkdirSync(probe.dir);
  const info = lstatSync(probe.dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new PoolError('UNSAFE_PROBE_DIRECTORY', 'Preflight probe directory must be a plain directory.');
  probe.created = true;
  const script = `// CLI Agent Pool preflight probe. Harmless: writes only into its own directory and one unreferenced git object.
import { createHash, createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const S = ${JSON.stringify({ ...probe.secrets, serviceNonce: probe.serviceNonce, port: probe.port, workspace: probe.workspace })};
const dir = path.dirname(fileURLToPath(import.meta.url));
const out = (name, value) => writeFileSync(path.join(dir, name), JSON.stringify(value));
const step = process.argv[2] || '';
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
if (/^shell-[abc]$/.test(step)) out(step + '.json', { mac: createHmac('sha256', S.shell).update(step).digest('hex') });
else if (step === 'commit') out('commit.json', { id: execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: S.workspace, input: S.commit }).toString().trim() });
else if (step === 'remote') {
  const listing = execFileSync('git', ['ls-remote', 'origin'], { cwd: S.workspace, env: gitEnv, timeout: 60000 }).toString();
  out('remote.json', { digest: createHash('sha256').update(listing.split(/\\r?\\n/).map(l => l.trim()).filter(Boolean).sort().join('\\n')).digest('hex') });
} else if (step === 'service') {
  const response = await fetch('http://127.0.0.1:' + S.port + '/preflight/' + S.serviceNonce, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: S.service }) });
  out('service.json', { status: response.status });
} else { console.error('unknown step'); process.exitCode = 2; }
`;
  writeFileSync(path.join(probe.dir, 'probe.mjs'), script, { flag: 'wx' });
}

export function probePrompt(probe) {
  const script = forward(path.join(probe.dir, 'probe.mjs'));
  const node = `node "${script}"`;
  const want = name => probe.capabilities.includes(name);
  const steps = [];
  if (want('shell')) steps.push(`Run this as ONE shell command, both lines together in a single tool call:\n${node} shell-a\n${node} shell-b; ${node} shell-c; echo probe-done`);
  if (want('gitCommit') && probe.facts.repository) steps.push(`Run: ${node} commit`);
  if (want('gitRemote') && probe.facts.origin) steps.push(`Run: ${node} remote`);
  if (want('poolService')) steps.push(`Run: ${node} service`);
  if (want('poolMcp')) steps.push(`Call the MCP tool pool_preflight_ack with arguments {"nonce":"${probe.mcpNonce}"}.`);
  if (want('readOutside')) probe.reads.forEach((item, index) => {
    if (item.target) steps.push(`With your file-read tool, read ${forward(item.target.file)}. Write line ${item.target.line} of it exactly, with no other text, into ${forward(path.join(probe.dir, `read-${index}.txt`))} using your file-write tool.`);
  });
  return `CLI Agent Pool preflight for a director task. Do ONLY the numbered steps below, in order. Do not read project instructions, do not change any other file, do not commit or push. If a step is denied or fails, continue with the next step and list it under blockers.\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n\n')}\n\nThen reply with ONLY this JSON (fill in status/blockers): {"status":"completed","summary":"preflight steps run","files":[],"checks":[],"research":[],"blockers":[]}`;
}

// The CLI's own tool events show whether the shell step ran as one call.
export function shellMarkers(probe) {
  return { all: SHELL_STEPS.map(step => `${step}`), scope: path.basename(probe.dir) };
}

function readJson(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('not a bounded plain file');
  return JSON.parse(readFileSync(file, 'utf8'));
}
function readText(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) throw new Error('not a bounded plain file');
  return readFileSync(file, 'utf8');
}

export function evaluateShellEvidence(events) {
  // events: arrays of step markers seen together in one native tool event.
  if (events.some(seen => seen.includes('shell-a') && seen.includes('shell-c'))) return 'verified';
  if (events.some(seen => seen.includes('shell-a')) && events.some(seen => seen.includes('shell-c'))) return 'split';
  return 'unverified';
}

export async function verifyProbe(probe, { python, remoteBefore, outcome }) {
  const results = {};
  const want = name => probe.capabilities.includes(name);
  const file = name => path.join(probe.dir, name);
  const set = (name, status, detail) => { results[name] = { status, ...(detail ? { detail } : {}) }; };
  const runError = outcome?.error && outcome.error !== 'PERMISSION_REQUIRED' && outcome.error !== 'INVALID_REPORT' && outcome.error !== 'WORK_INCOMPLETE' ? outcome.error : null;
  if (runError) {
    for (const capability of probe.capabilities) set(capability, 'failed', `Preflight run failed: ${runError}.`);
    return { capabilities: results, singleInvocation: null, taskToken: null, runError, runMessage: outcome?.message || outcome?.detail || null };
  }
  let singleInvocation = null;
  if (want('shell')) {
    const ran = SHELL_STEPS.every(step => { try { return readJson(file(`${step}.json`)).mac === createHmac('sha256', probe.secrets.shell).update(step).digest('hex'); } catch { return false; } });
    singleInvocation = evaluateShellEvidence(probe.markers);
    if (!ran) set('shell', 'failed', 'The multi-line compound probe command did not run (all three steps must write their files).');
    else if (singleInvocation === 'split') set('shell', 'failed', 'The model split the multi-line command into separate calls; one compound invocation was not shown to work.');
    else set('shell', 'passed', singleInvocation === 'unverified' ? 'Steps ran; the CLI events did not show the command text, so a single invocation is unverified.' : null);
  }
  if (want('gitCommit')) {
    if (!probe.facts.repository) set('gitCommit', 'not_applicable', 'Workspace is not a git repository.');
    else {
      const expected = await run(['git', '-C', probe.workspace, 'hash-object', '--stdin'], probe.workspace, python, { input: probe.secrets.commit });
      const id = expected.code === 0 ? expected.output.trim() : '';
      const exists = id ? await run(['git', '-C', probe.workspace, 'cat-file', '-e', id], probe.workspace, python) : { code: 1 };
      set('gitCommit', exists.code === 0 && !exists.stopReason ? 'passed' : 'failed', exists.code === 0 ? null : 'No git object was written by the task.');
    }
  }
  if (want('gitRemote')) {
    if (!probe.facts.origin) set('gitRemote', 'not_applicable', 'No origin remote.');
    else {
      let digest = null; try { digest = readJson(file('remote.json')).digest; } catch { /* missing */ }
      const after = await poolRemoteDigest(probe.workspace, python);
      if (!remoteBefore && !after) set('gitRemote', 'failed', 'Pool itself could not list origin (credentials or network); fix git access first.');
      else set('gitRemote', digest && (digest === remoteBefore || digest === after) ? 'passed' : 'failed', digest ? (digest === remoteBefore || digest === after ? null : 'Listing differed from origin.') : 'The task could not list origin.');
    }
  }
  if (want('poolService')) set('poolService', probe.acks.has('poolService') ? 'passed' : 'failed', probe.acks.has('poolService') ? null : 'A shell command could not reach the Pool service on 127.0.0.1.');
  let taskToken = null;
  if (want('poolMcp')) {
    const ack = probe.acks.get('poolMcp');
    taskToken = ack ? (ack.token ? 'verified' : 'missing') : null;
    set('poolMcp', ack?.token ? 'passed' : 'failed', ack ? (ack.token ? null : 'The MCP bridge did not carry the task token; director worker linking is unavailable.') : 'The task did not call pool_preflight_ack.');
  }
  if (want('readOutside')) {
    if (!probe.reads.length) set('readOutside', 'not_applicable', 'No read paths requested.');
    else {
      const failed = probe.reads.map((item, index) => {
        if (!item.target) return `${item.directory}: no readable text file to probe`;
        if (!item.nativeRead || outcome?.error === 'PERMISSION_REQUIRED') return `${item.directory}: native file-read tool evidence is unverified`;
        try { return readText(file(`read-${index}.txt`)).replace(/\r?\n$/, '').trimEnd() === item.target.text.trimEnd() ? null : `${item.directory}: wrong line`; }
        catch { return `${item.directory}: not read`; }
      }).filter(Boolean);
      set('readOutside', failed.length ? 'failed' : 'passed', failed.length ? failed.join('; ') : null);
      results.readOutside.nativeRead = probe.reads.every(item => item.nativeRead) && outcome?.error !== 'PERMISSION_REQUIRED' ? 'verified' : 'unverified';
    }
  }

  return { capabilities: results, singleInvocation, taskToken, runError, runMessage: runError ? outcome?.message || outcome?.detail || null : null };
}

// Remove only the files Pool expects, then the (now empty) directory.
export function cleanupProbe(dir, reads = 8) {
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
  } catch { return true; }
  for (const name of expectedFiles(Array.from({ length: reads }))) {
    const file = path.join(dir, name);
    try { const info = lstatSync(file); if (info.isFile() || info.isSymbolicLink()) unlinkSync(file); } catch { /* absent */ }
  }
  try { rmdirSync(dir); return true; } catch { return false; }
}

export function fixFor(route, capability, context = {}) {
  const adapter = route.adapter;
  const projectFile = context.projectFile ? ` in ${context.projectFile}` : ' in the Antigravity project for this workspace';
  const claudeLocal = context.workspace ? path.join(context.workspace, '.claude', 'settings.local.json') : '.claude/settings.local.json';
  const table = {
    shell: { agy: `Add command(*) (or the exact commands the director needs) to permissionGrants.allow${projectFile}.`,
      claude: `Add "Bash(node:*)", "Bash(git:*)" and the director's other commands to permissions.allow in ${claudeLocal}.`,
      codex: 'The codex sandbox denied the probe command; check $CODEX_HOME/rules and choose another director route if it stays denied.' },
    gitCommit: { agy: `Allow git commands (command(git *) or command(*))${projectFile}.`,
      claude: `Add "Bash(git:*)" to permissions.allow in ${claudeLocal}.`,
      codex: 'The native sandbox denied writing git objects; choose another director route.' },
    gitRemote: { agy: `Allow git network commands${projectFile} and check git credentials.`,
      claude: `Add "Bash(git:*)" to permissions.allow in ${claudeLocal} and check git credentials.`,
      codex: `Owner: enable sandboxNetwork on route ${route.id} (director tasks only), and check git credentials.` },
    poolService: { agy: `Allow node commands${projectFile}.`,
      claude: `Add "Bash(node:*)" to permissions.allow in ${claudeLocal}.`,
      codex: `Owner: enable sandboxNetwork on route ${route.id}; the codex command sandbox blocks 127.0.0.1 by default. MCP tools still work.` },
    poolMcp: { agy: 'Register the Pool stdio server in ~/.gemini/config/mcp_config.json (cli-agent-pool install does this) and allow mcp(cli-agent-pool*) in the project grants.',
      claude: `Allow "mcp__cli-agent-pool__*" in permissions.allow in ${claudeLocal}.`,
      codex: 'Check that the codex CLI version supports -c mcp_servers.<name> overrides.' },
    readOutside: { agy: `Add read_file(<path>) for each read path to permissionGrants.allow${projectFile}.`,
      claude: 'Check that each read path is under directorReadRoots; Pool passes a read-only allow rule for it.',
      codex: 'The codex sandbox could not read the path; check directorReadRoots and the path itself.' },
  };
  return table[capability]?.[adapter] || 'Review the native CLI permission settings for this workspace.';
}

export function projectFileFor(route, workspace, directory = null) {
  if (route.adapter !== 'agy' || route.runtime === 'wsl') return null;
  try {
    const agyHome = directory ? profileHome(route, directory) : homedir();
    const matches = agyProjectMatches(workspace, agyHome);
    return (matches.length ? matches : agyProjectMatches(workspace))[0]?.file || null;
  } catch { return null; }
}

export function summarize(entry) {
  if (!entry) return null;
  const failed = Object.entries(entry.capabilities || {}).filter(([, value]) => value.status === 'failed');
  return { status: entry.status, ready: entry.status === 'ready' && !entry.runError, observedAt: entry.observedAt, checkedAt: entry.observedAt, retryAfter: entry.retryAfter || null, runError: entry.runError || null, error: entry.runError || null,
    singleInvocation: entry.singleInvocation || null, taskToken: entry.taskToken || null, taskId: entry.taskId || null,
    capabilities: entry.capabilities, failed: failed.map(([name, value]) => ({ capability: name, detail: value.detail || null, fix: value.fix })) };
}
