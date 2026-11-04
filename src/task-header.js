// A director run's task token (lease) travels from its environment to Pool as a header.
export function taskHeader(env = process.env) {
  const token = env.CLI_AGENT_POOL_TASK_TOKEN;
  return { ...(env.CLI_AGENT_POOL_WORKER === '1' ? { 'X-Pool-Worker': '1' } : {}), ...(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? { 'X-Pool-Task': token } : {}) };
}
