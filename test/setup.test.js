import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup } from '../scripts/setup.js';

test('Windows setup runs npm through Node and installs the package before desktop/skills', async () => {
  const calls = [];
  const npm = path.join(path.dirname(process.execPath), 'npm-cli.js');
  let installed = false;
  const result = await setup({ npm, directory: 'runtime', run: async spec => {
    calls.push(spec);
    return { code: 0, output: spec.argv.includes('pack') ? 'cli-agent-pool-1.7.1.tgz\n' : '', stopReason: null };
  }, install: async directory => { assert.equal(calls.length, 2); assert.equal(directory, 'runtime'); installed = true; return { ready: true }; } });
  assert(installed); assert.deepEqual(result, { ready: true });
  assert.equal(calls[0].argv[0], process.execPath); assert.equal(calls[0].argv[1], npm);
  const destination = calls[0].argv.at(-1);
  assert(!destination.startsWith(calls[0].cwd));
  assert.equal(calls[1].argv[4], path.join(destination, 'cli-agent-pool-1.7.1.tgz'));
  assert(calls.every(call => call.timeoutMs === 120_000 && !call.argv.some(arg => /\.(cmd|bat)$/.test(arg))));
});

test('setup never claims desktop/skill installation after npm build/install failure', async () => {
  for (const failAt of [1, 2]) {
    let count = 0;
    await assert.rejects(setup({ npm: 'npm-cli.js', directory: 'runtime', run: async () => ({code: ++count === failAt ? 1 : 0, output: 'cli-agent-pool-1.7.1.tgz'}), install: async () => assert.fail('must not install desktop on npm failure') }), { code: failAt === 1 ? 'PACKAGE_BUILD_FAILED' : 'PACKAGE_INSTALL_FAILED' });
    assert.equal(count, failAt);
  }
});
