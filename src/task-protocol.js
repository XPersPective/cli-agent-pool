import { PoolError, overlaps } from './config.js';
import { z } from 'zod';

export const executionReportSchema = z.object({
  status: z.enum(['completed', 'partial', 'blocked']),
  summary: z.string().min(1).max(800),
  files: z.array(z.object({ path: z.string().min(1).max(300), change: z.string().min(1).max(200) }).strict()).max(50),
  checks: z.array(z.object({ command: z.string().min(1).max(200), outcome: z.enum(['passed', 'failed', 'not_run']) }).strict()).max(20),
  research: z.array(z.object({ source: z.string().min(1).max(500), finding: z.string().min(1).max(200) }).strict()).max(10),
  blockers: z.array(z.string().min(1).max(300)).max(10),
}).strict().refine(report => JSON.stringify(report).length <= 6000, 'Report must fit 6000 characters');

export function parseExecutionReport(result) {
  try {
    const json = JSON.parse(result.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, ''));
    return executionReportSchema.parse(json);
  } catch { return null; }
}

const executionAdapters = new Set(['codex', 'claude', 'opencode', 'mimo', 'zcode', 'qwen', 'mcode', 'kimi', 'agy']);

export function supportsExecution(route) {
  return Boolean(route.argsTemplate?.length) || executionAdapters.has(route.adapter);
}

export function validateMode(task) {
  if (task.mode === 'execute' && task.kind !== 'write')
    throw new PoolError('INVALID_REQUEST', 'execute modu kind: write gerektirir.');
  if (task.mode === 'response' && task.kind === 'write')
    throw new PoolError('INVALID_REQUEST', 'response modu text veya read gerektirir; dosya değişikliği için execute kullanın.');
}

export function taskPrompt(task) {
  if (task.mode !== 'execute') return task.prompt;
  return `${task.prompt}\n\n[CLI Agent Pool subagent protocol v1]\nWork in the supplied workspace. Read its AGENTS.md and applicable project instructions. Perform the requested work using native file, command and research tools; run relevant checks. Preserve unrelated edits. Respect native permission checks; report denied tools as blockers. Do not delegate back into Pool, change Pool billing/quota policy, commit, push, publish or deploy unless the task explicitly authorizes it. Do not merely propose changes. Finish with ONLY one JSON report (maximum 200 words and 6000 characters) in this exact format: {"status":"completed|partial|blocked","summary":"short outcome","files":[{"path":"relative/path","change":"what changed"}],"checks":[{"command":"actual command","outcome":"passed|failed|not_run"}],"research":[{"source":"URL or source path","finding":"short finding"}],"blockers":["remaining work or denied permission"]}. Use one allowed enum value, not the pipe-separated examples. All six fields are required; use empty arrays when absent. List every changed file, actual pass/fail checks, and sources used for research. Never claim unperformed work or infer successful tests. The calling agent reviews the changes.\n[End protocol]`;
}

export function workspaceConflict(held, task) {
  if (!overlaps(held.workspace, task.workspace)) return false;
  return held.state === 'needs_review' || held.kind === 'write' || task.kind === 'write';
}

// Bound the returned report, retaining the full native answer in local task history.
export function compactTask(task) {
  const limit = 6000;
  const truncated = !task.report && typeof task.result === 'string' && task.result.length > limit;
  return Object.fromEntries(Object.entries({ ...task,
    result: task.report ? undefined : truncated ? task.result.slice(0, limit) + '\n[Report truncated; retrieve full task for remaining details.]' : task.result,
    reportTruncated: truncated,
  }).filter(([key, value]) => !['prompt', 'events'].includes(key) && value !== undefined));
}

export async function waitForTask(getTask, id, { waitSeconds = 3600, now = Date.now, sleep } = {}) {
  const deadline = now() + waitSeconds * 1000;
  for (;;) {
    const task = await getTask(id);
    if (!['queued', 'starting', 'running', 'cancelling'].includes(task.state)) return task;
    if (task.queueReason === 'WORKSPACE_REVIEW_REQUIRED' || now() >= deadline)
      return { ...task, waitExpired: now() >= deadline, resume: { tool: 'pool_get_task', arguments: { taskId: id, compact: true } } };
    await sleep(500);
  }
}
