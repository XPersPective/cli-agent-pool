import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveWindowsPython, runProcess } from '../src/process.js';

const execFileAsync = promisify(execFile);

test('Windows background supervisor isolates child and grandchild processes on hidden desktop while keeping windowsHide:false visible', { skip: process.platform !== 'win32' }, async () => {
  const checkDesktop = [
    'import ctypes',
    'u = ctypes.WinDLL("user32")',
    'k = ctypes.WinDLL("kernel32")',
    'h = u.GetThreadDesktop(k.GetCurrentThreadId())',
    'b = ctypes.create_unicode_buffer(256)',
    'n = ctypes.c_ulong()',
    'u.GetUserObjectInformationW(h, 2, b, 512, ctypes.byref(n))',
    'print(b.value)',
  ].join('; ');
  const spawnGrandchild = [
    'import subprocess, sys',
    'p = subprocess.run([sys.executable, "-c", sys.argv[1]], capture_output=True, text=True)',
    'print(p.stdout.strip())',
  ].join('; ');
  const py = resolveWindowsPython('python', { preferWindowless: false });

  const hidden = await runProcess({ argv: [py, '-c', spawnGrandchild, checkDesktop], cwd: process.cwd(), windowsHide: true }).done;
  assert.equal(hidden.code, 0, hidden.stderr);
  assert.equal(hidden.output.trim(), 'CliAgentPoolBg');

  const visible = await runProcess({ argv: [py, '-c', spawnGrandchild, checkDesktop], cwd: process.cwd(), windowsHide: false }).done;
  assert.equal(visible.code, 0, visible.stderr);
  assert.notEqual(visible.output.trim(), 'CliAgentPoolBg');
});

test('wincred.py exits cleanly with code 2 for absent credential target without powershell/csc', { skip: process.platform !== 'win32' }, async () => {
  const script = fileURLToPath(new URL('../src/wincred.py', import.meta.url));
  const pyw = resolveWindowsPython('python', { preferWindowless: true });
  await assert.rejects(
    execFileAsync(pyw, [script, 'cli-agent-pool:nonexistent-test-target-0000'], { windowsHide: true, timeout: 10_000 }),
    error => error.code === 2,
  );
});

test('dashboard.cs launches ensure hidden with CreateNoWindow and ProcessWindowStyle.Hidden and targets WinSta0\\Default', () => {
  const source = readFileSync(new URL('../src/dashboard.cs', import.meta.url), 'utf8');
  const picker = readFileSync(new URL('../src/folder-picker.cs', import.meta.url), 'utf8');
  assert.match(source, /CreateNoWindow=true/);
  assert.match(source, /WindowStyle=ProcessWindowStyle\.Hidden/);
  assert.match(source, /OpenDesktopW\("Default"/);
  assert.match(source, /SetThreadDesktop\(/);
  assert.doesNotMatch(source, /\[STAThread\]\s*static int Main/);
  assert.match(source, /WinSta0\\\\Default/);
  assert.match(picker, /TryReexecOnDefaultDesktop/);
  assert.match(picker, /WinSta0\\\\Default/);
});

test('winlogin.py launches CLI login on interactive WinSta0\\Default even when called from hidden CliAgentPoolBg desktop', { skip: process.platform !== 'win32' }, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pool-winlogin-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  const outFile = path.join(dir, 'desktop.json');
  const pyw = resolveWindowsPython('python', { preferWindowless: true });
  const winlogin = fileURLToPath(new URL('../src/winlogin.py', import.meta.url));
  const probeCode = [
    'import ctypes, json, os, sys',
    'u = ctypes.WinDLL("user32")',
    'k = ctypes.WinDLL("kernel32")',
    'h = u.GetThreadDesktop(k.GetCurrentThreadId())',
    'b = ctypes.create_unicode_buffer(256)',
    'n = ctypes.c_ulong()',
    'u.GetUserObjectInformationW(h, 2, b, 512, ctypes.byref(n))',
    'open(sys.argv[1], "w", encoding="utf-8").write(json.dumps({"desktop": b.value, "claudeDir": os.environ.get("CLAUDE_CONFIG_DIR"), "leakedArgv": "CLI_AGENT_POOL_LOGIN_ARGV" in os.environ}))',
  ].join('; ');
  const payload = JSON.stringify({ file: pyw, arguments: ['-c', probeCode, outFile] });
  // Run winlogin.py inside the hidden CliAgentPoolBg desktop and wait for the probe
  // before supervisor.py exits (supervisor.py's kill-on-close Job Object terminates
  // descendants as soon as its child exits).
  const wrapperCode = [
    'import json, os, subprocess, sys, time',
    'p = subprocess.run([sys.executable, sys.argv[1]], capture_output=True, text=True, check=True)',
    'out = sys.argv[2]',
    'for _ in range(100):',
    '  if os.path.exists(out): break',
    '  time.sleep(0.05)',
    'print(p.stdout.strip())',
  ].join('\n');
  const result = await runProcess({
    argv: [pyw, '-c', wrapperCode, winlogin, outFile],
    cwd: dir,
    extraEnv: { CLAUDE_CONFIG_DIR: dir, CLI_AGENT_POOL_LOGIN_ARGV: payload },
    windowsHide: true,
    timeoutMs: 15_000,
  }).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.output).opened, true);
  assert.equal(existsSync(outFile), true, 'launched child should write its desktop probe');
  const observed = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.equal(observed.desktop, 'Default');
  assert.equal(observed.claudeDir, dir);
  assert.equal(observed.leakedArgv, false);
});
