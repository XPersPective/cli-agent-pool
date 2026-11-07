import { PoolError, overlaps } from './config.js';
import { z } from 'zod';

export const executionReportSchema = z.object({
  status: z.enum(['completed', 'partial', 'blocked']),
  summary: z.string().min(1).max(4000),
  files: z.array(z.object({ path: z.string().min(1).max(500), change: z.string().min(1).max(1000) }).strict()).max(250),
  checks: z.array(z.object({ command: z.string().min(1).max(1000), outcome: z.enum(['passed', 'failed', 'not_run']) }).strict()).max(100),
  research: z.array(z.object({ source: z.string().min(1).max(1000), finding: z.string().min(1).max(1000) }).strict()).max(100),
  blockers: z.array(z.string().min(1).max(1000)).max(100),
}).strict().refine(report => JSON.stringify(report).length <= 32_768, 'Report must fit 32768 characters');

export const executionReportJsonSchema = z.toJSONSchema(executionReportSchema);

function extractTrailingJsonObject(text) {
  const end = text.lastIndexOf('}');
  if (end < 0 || text.slice(end + 1).trim()) return null;
  let depth = 0;
  let inString = false;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (ch === '"') {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) backslashes++;
      if (backslashes % 2 === 0) inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return null;
}

function normalizeReportCandidate(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return executionReportSchema.parse({
    status: parsed.status,
    summary: parsed.summary,
    files: parsed.files ?? [],
    checks: parsed.checks ?? [],
    research: parsed.research ?? [],
    blockers: parsed.blockers ?? [],
  });
}

export function parseExecutionReport(result) {
  if (typeof result !== 'string') return null;
  const trimmed = result.trim();
  if (!trimmed) return null;
  const candidates = [trimmed.replace(/^```(?:json)?\s*\r?\n?/, '').replace(/\r?\n?```$/, '')];
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length > 1) candidates.push(lines.at(-1));
  const trailingFence = trimmed.match(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/);
  if (trailingFence) candidates.push(trailingFence[1].trim());
  const trailingObject = extractTrailingJsonObject(trimmed);
  if (trailingObject) candidates.push(trailingObject);
  for (const candidate of candidates) {
    try {
      const valid = normalizeReportCandidate(candidate);
      if (valid) return valid;
    } catch { /* try next candidate */ }
  }
  return null;
}

const executionAdapters = new Set(['codex', 'claude', 'opencode', 'mimo', 'zcode', 'qoder', 'qwen', 'mcode', 'kimi', 'agy']);

export function supportsExecution(route) {
  return Boolean(route.argsTemplate?.length) || executionAdapters.has(route.adapter);
}

export function validateMode(task) {
  if (task.mode === 'execute' && task.kind !== 'write')
    throw new PoolError('INVALID_REQUEST', 'execute modu kind: write gerektirir.');
  if (task.mode === 'response' && task.kind === 'write')
    throw new PoolError('INVALID_REQUEST', 'response modu text veya read gerektirir; dosya değişikliği için execute kullanın.');
}

const reportFormat = `Finish with ONLY one JSON report (maximum 200 words and 6000 characters) in this exact format: {"status":"completed|partial|blocked","summary":"short outcome","files":[{"path":"relative/path","change":"what changed"}],"checks":[{"command":"actual command","outcome":"passed|failed|not_run"}],"research":[{"source":"URL or source path","finding":"short finding"}],"blockers":["remaining work or denied permission"]}. Use one allowed enum value, not the pipe-separated examples. All six fields are required; use empty arrays when absent.`;

// Director prompt authorizes only the work described by the caller; relay decisions stay external.
export function directorPrompt(task, context) {
  return `${task.prompt}\n\n[CLI Agent Pool director protocol v1]\nYou are a director working in ${task.workspace}. Follow the task and project instructions. Use Pool MCP to start and poll workers in external sibling worktrees; overlapping workers and paid API workers are refused. You may commit/push when authorized by the task. Relay selection and recovery belong to the caller's relay system. Honor its takeover and handoff protocol. Native permission checks apply; report denied tools as blockers. Never disclose environment secrets or task tokens. ${reportFormat} Never claim unperformed work.\n[End protocol]`;
}

export function taskPrompt(task, context = null) {
  if (context?.promptOverride) return context.promptOverride;
  if (context?.profile === 'director') return directorPrompt(task, context);
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
  const compactResult = !truncated ? task.result : `${task.result.slice(0, 2900)}\n[... ${task.result.length - 5800} chars omitted; retrieve full task if needed ...]\n${task.result.slice(-2900)}`;
  return Object.fromEntries(Object.entries({ ...task,
    result: task.report ? undefined : compactResult,
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
