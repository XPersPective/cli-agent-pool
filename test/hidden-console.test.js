import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

test('dashboard.cs launches ensure hidden with CreateNoWindow and ProcessWindowStyle.Hidden', () => {
  const source = readFileSync(new URL('../src/dashboard.cs', import.meta.url), 'utf8');
  assert.match(source, /CreateNoWindow=true/);
  assert.match(source, /WindowStyle=ProcessWindowStyle\.Hidden/);
});
