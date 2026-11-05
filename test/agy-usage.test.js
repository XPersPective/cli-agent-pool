import test from 'node:test';
import assert from 'node:assert/strict';
import { agyUsageWindows } from '../src/quotas.js';

test('agy /usage report maps Gemini, Claude/GPT and Argon buckets with reset times', () => {
  const report = { command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [
      { window: 'weekly', remaining_fraction: 0.7130506, reset_time: '2026-11-11T13:58:45Z' },
      { window: '5h', remaining_fraction: 0.98993, reset_time: '2026-11-06T02:49:31Z' }] },
    { name: 'Claude and GPT models', buckets: [{ window: 'weekly', remaining_fraction: 0.9185, reset_time: '2026-11-12T15:12:23Z' }] },
    { name: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remaining_fraction: 0, reset_time: '2026-11-12T11:55:52Z' }] },
  ] } } };
  const windows = agyUsageWindows(report);
  assert.equal(windows.length, 4);
  assert.deepEqual(windows[0], { name: 'Gemini Models:weekly', remainingPercent: 71.3051, resetsAt: '2026-11-11T13:58:45Z', windowMinutes: 10080, models: ['gemini-flash', 'gemini-pro'] });
  assert.equal(windows[1].windowMinutes, 300);
  assert.deepEqual(windows[3].models, ['gemini-4-argon']);
  assert.equal(windows[3].remainingPercent, 0);
  assert.deepEqual(agyUsageWindows({}), []);
});
