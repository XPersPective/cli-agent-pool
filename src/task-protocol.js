import { PoolError } from './config.js';
import { z } from 'zod';

export const executionReportSchema = z.object({
  status: z.enum(['completed', 'partial', 'blocked']),
  summary: z.string().min(1),
  files: z.array(z.object({ path: z.string().min(1), change: z.string().min(1) }).strict()),
  checks: z.array(z.object({ command: z.string().min(1), outcome: z.enum(['passed', 'failed', 'not_run']) }).strict()),
  research: z.array(z.object({ source: z.string().min(1), finding: z.string().min(1) }).strict()),
  blockers: z.array(z.string().min(1)),
}).strict();

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
  const fences = [...trimmed.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/g)];
  if (fences.length) {
    const lastFence = fences.at(-1);
    if (!trimmed.slice(lastFence.index + lastFence[0].length).trim()) candidates.push(lastFence[1].trim());
  }
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

const reportFormat = `Finish with ONLY one JSON report in this exact format: {"status":"completed|partial|blocked","summary":"short outcome","files":[{"path":"relative/path","change":"what changed"}],"checks":[{"command":"actual command","outcome":"passed|failed|not_run"}],"research":[{"source":"URL or source path","finding":"short finding"}],"blockers":["remaining work or denied permission"]}. Use one allowed enum value, not the pipe-separated examples. All six fields are required; use empty arrays when absent.`;

// Director prompt authorizes only the work described by the caller; relay decisions stay external.
export function directorPrompt(task, context) {
  return `${task.prompt}\n\n[CLI Agent Pool director protocol v1]\nYou are a director working in ${task.workspace}. Follow the task and project instructions. Use Pool MCP to start and poll workers in external sibling worktrees; overlapping workers and paid API workers are refused. You may commit/push when authorized by the task. Relay selection and recovery belong to the caller's relay system. Honor its takeover and handoff protocol. Native permission checks apply; report denied tools as blockers. Never disclose environment secrets or task tokens. ${reportFormat} Never claim unperformed work.\n[End protocol]`;
}

export function taskPrompt(task, context = null) {
  if (context?.promptOverride) return context.promptOverride;
  if (context?.profile === 'director') return directorPrompt(task, context);
  if (task.mode !== 'execute') return task.prompt;
  return `${task.prompt}\n\n[CLI Agent Pool subagent protocol v1]\nWork in the supplied workspace. Read its AGENTS.md and applicable project instructions. Perform the requested work using native file, command and research tools; run relevant checks. Preserve unrelated edits. Respect native permission checks; report denied tools as blockers. Do not delegate back into Pool, change Pool billing/quota policy, commit, push, publish or deploy unless the task explicitly authorizes it. Do not merely propose changes. Finish with ONLY one JSON report in this exact format: {"status":"completed|partial|blocked","summary":"short outcome","files":[{"path":"relative/path","change":"what changed"}],"checks":[{"command":"actual command","outcome":"passed|failed|not_run"}],"research":[{"source":"URL or source path","finding":"short finding"}],"blockers":["remaining work or denied permission"]}. Use one allowed enum value, not the pipe-separated examples. All six fields are required; use empty arrays when absent. List every changed file, actual pass/fail checks, and sources used for research. Never claim unperformed work or infer successful tests. The calling agent reviews the changes.\n[End protocol]`;
}

export function workspaceConflict() {
  // CLI Agent Pool routes and runs CLI tasks without imposing workspace locks;
  // callers and orchestrators decide when multiple agents share a project folder.
  return false;
}

// Omit duplicated prompt/events metadata while preserving the full output without character truncation.
export function compactTask(task) {
  return Object.fromEntries(Object.entries({ ...task,
    result: task.report ? undefined : task.result,
    reportTruncated: false,
  }).filter(([key, value]) => !['prompt', 'events'].includes(key) && value !== undefined));
}

export async function waitForTask(getTask, id, { waitSeconds = 0, now = Date.now, sleep } = {}) {
  const deadline = waitSeconds > 0 ? now() + waitSeconds * 1000 : Infinity;
  for (;;) {
    const task = await getTask(id);
    if (!['queued', 'starting', 'running', 'cancelling'].includes(task.state)) return task;
    if (now() >= deadline)
      return { ...task, waitExpired: true, resume: { tool: 'pool_get_task', arguments: { taskId: id, compact: true } } };
    await sleep(500);
  }
}
