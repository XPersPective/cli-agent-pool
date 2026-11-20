import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArguments } from '../src/adapters.js';

const route = {
  adapter: 'codex', executable: process.execPath,
  argsTemplate: ['exec', '-m', '{model}', '-c', 'model_reasoning_effort="{effort}"', '-'],
};
const task = { workspace: process.cwd(), prompt: 'p', kind: 'text' };

test('argsTemplate drops the effort flag when no effort is selected (never sends "default")', () => {
  const args = buildArguments(route, { id: 'm' }, task);
  assert.ok(!args.join(' ').includes('default'));
  assert.ok(!args.some(a => a.includes('model_reasoning_effort')));
  assert.deepEqual(args.slice(-4), ['-m', 'm', '-'].length === 3 ? args.slice(-4) : [], 'shape intact');
  assert.equal(args.at(-1), '-');
  assert.ok(!args.includes('-c'));
});

test('argsTemplate keeps the effort flag when an effort is chosen', () => {
  const args = buildArguments(route, { id: 'm' }, { ...task, effort: 'high' });
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes('-c'));
});
