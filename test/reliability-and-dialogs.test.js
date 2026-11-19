import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWindowsPython, childEnvironment } from '../src/process.js';
import { classifyFailure, mergeCatalogModels } from '../src/adapters.js';
import { agyUsageWindows, antigravityGroupWindows } from '../src/quotas.js';
import { configSchema } from '../src/config.js';
import { compareSemver, checkUpdateStatus } from '../src/daemon.js';
import { modelFamily, quotaApplies } from '../web/pool-state.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('resolveWindowsPython unwraps venv trampoline stubs to base pythonw.exe without popping consoles', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pool-py-resolve-'));
  const baseDir = path.join(dir, 'cpython-3.11');
  const venvDir = path.join(dir, 'venv');
  const scriptsDir = path.join(venvDir, 'Scripts');
  const storeDir = path.join(dir, 'Microsoft', 'WindowsApps');
  mkdirSync(baseDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(storeDir, { recursive: true });

  writeFileSync(path.join(baseDir, 'python.exe'), 'real-python');
  writeFileSync(path.join(baseDir, 'pythonw.exe'), 'real-pythonw');
  writeFileSync(path.join(scriptsDir, 'python.exe'), 'venv-trampoline');
  writeFileSync(path.join(venvDir, 'pyvenv.cfg'), `home = ${baseDir}\nimplementation = CPython\n`);
  writeFileSync(path.join(storeDir, 'python.exe'), ''); // 0-byte WindowsApps stub

  const envPath = `${storeDir};${scriptsDir}`;
  const hiddenBin = resolveWindowsPython('python', { platform: 'win32', envPath, preferWindowless: true });
  assert.equal(hiddenBin, path.join(baseDir, 'pythonw.exe'));

  const consoleBin = resolveWindowsPython('python', { platform: 'win32', envPath, preferWindowless: false });
  assert.equal(consoleBin, path.join(baseDir, 'python.exe'));
});

test('childEnvironment preserves required Windows OS variables while stripping API secrets', () => {
  const prevSecret = process.env.OPENAI_API_KEY;
  const prevOs = process.env.OS;
  process.env.OPENAI_API_KEY = 'sk-should-not-leak';
  process.env.OS = 'Windows_NT';
  try {
    const env = childEnvironment();
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.OS, 'Windows_NT');
  } finally {
    if (prevSecret === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevSecret;
    if (prevOs === undefined) delete process.env.OS; else process.env.OS = prevOs;
  }
});

test('classifyFailure accurately classifies Antigravity wsarecv/tcp drops and Claude auth/model errors', () => {
  assert.equal(
    classifyFailure('There was a network issue connecting to the server, please try again. Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": read tcp 192.168.1.100:58357->172.217.119.4:443: wsarecv: timeout'),
    'NETWORK_UNAVAILABLE',
  );
  assert.equal(
    classifyFailure('request failed: write tcp 192.168.1.100:1234->1.2.3.4:443: wsasend: connection aborted'),
    'NETWORK_UNAVAILABLE',
  );
  assert.equal(
    classifyFailure('Failed to authenticate: OAuth session expired and could not be refreshed'),
    'AUTH_REQUIRED',
  );
  assert.equal(
    classifyFailure('[claude-code:unrecognized_model] {"model":"claude-fable-5-2"}'),
    'MODEL_UNAVAILABLE',
  );
});

test('gemini-4-neon maps to neon family and matches Antigravity Gemini quota windows', () => {
  assert.equal(modelFamily('gemini-4-neon'), 'neon');
  const usageWins = agyUsageWindows({
    command: {
      data: {
        groups: [
          { name: 'Gemini Models', buckets: [{ window: '5h', remaining_fraction: 0.85 }] },
          { name: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remaining_fraction: 0.4 }] },
        ],
      },
    },
  });
  const geminiWin = usageWins.find(w => w.name.startsWith('Gemini Models'));
  assert.ok(geminiWin);
  assert.equal(quotaApplies(geminiWin, 'gemini-4-neon'), true);

  const cloudWins = antigravityGroupWindows({
    groups: [{ displayName: 'Gemini Neon & Hydrogen', buckets: [{ window: '5h', remainingFraction: 0.7 }] }],
  });
  assert.equal(cloudWins.length, 1);
  assert.equal(quotaApplies(cloudWins[0], 'gemini-4-neon'), true);
});

test('routes accept more than 100 models so newly released models enter the catalog', () => {
  const existingModels = Array.from({ length: 105 }, (_, i) => ({
    id: `opencode/old-model-${i}`,
    alias: `Old ${i}`,
    group: 'unassigned',
    enabled: true,
    efforts: [],
    kinds: ['text', 'read', 'write'],
  }));
  const route = {
    id: 'opencode-local',
    adapter: 'opencode',
    executable: process.execPath,
    enabled: true,
    billing: 'free_credits',
    models: existingModels,
  };
  const added = mergeCatalogModels(route, {
    models: [
      { id: 'opencode/gpt-6.2-sol', name: 'GPT 6.2 Sol', efforts: [], free: false },
      { id: 'opencode/hy4-flash-free', name: 'HY4 Flash Free', efforts: [], free: true },
    ],
  });
  assert.equal(added, 2);
  assert.ok(route.models.some(m => m.id === 'opencode/gpt-6.2-sol'));
  assert.ok(route.models.some(m => m.id === 'opencode/hy4-flash-free' && m.billing === 'free'));

  const parsed = configSchema.parse({ workspaceRoots: [process.cwd()], routes: [route] });
  assert.equal(parsed.routes[0].models.length, 107);
});

test('compareSemver and checkUpdateStatus detect local restart and newer remote releases', async () => {
  assert.equal(compareSemver('2.19.0', '2.18.0') > 0, true);
  assert.equal(compareSemver('2.18.0', '2.18.0'), 0);
  assert.equal(compareSemver('2.18.0', '2.19.0') < 0, true);

  const fakeDir = mkdtempSync(path.join(tmpdir(), 'pool-upd-'));
  writeFileSync(path.join(fakeDir, 'package.json'), JSON.stringify({ version: '2.19.0' }));
  const mockFetch = async () => ({
    ok: true,
    json: async () => [{ name: 'v2.20.0' }, { name: 'v2.19.0' }],
  });

  const status = await checkUpdateStatus({
    runningVersion: '2.18.0',
    installedRoot: fakeDir,
    fetchImpl: mockFetch,
    force: true,
  });
  assert.equal(status.runningVersion, '2.18.0');
  assert.equal(status.installedVersion, '2.19.0');
  assert.equal(status.latestVersion, '2.20.0');
  assert.equal(status.restartRequired, true);
  assert.equal(status.remoteNewer, true);
  assert.equal(status.updateAvailable, true);
  assert.equal(status.targetVersion, '2.20.0');
});

test('UI confirm dialog and pool add buttons are never disabled while confirming', () => {
  const app = readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
  assert.match(app, /if \(!node\.closest\('#confirm-dialog'\)\) node\.disabled = true/);
  assert.match(app, /okBtn\.disabled = false;/);
  assert.match(app, /function plainButton\(/);
  assert.match(app, /function confirmedButton\(/);
  assert.match(app, /plainButton\(groupLabel\(group\)/);
  assert.match(app, /plainButton\(`\$\{groupLabel\(group\)\}\$\{existing \? ' · ekli' : ''\}`/);
  assert.match(app, /function applyUpdateStatus\(/);
  assert.match(app, /function checkForUpdates\(/);
});
