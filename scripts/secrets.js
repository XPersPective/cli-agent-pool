import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const unique = [...new Set(files)];
const patterns = [
  /\bsk-(?:cp-|api-|ant-)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{24,}\b/,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /Authorization:\s*Bearer\s+[a-f0-9]{48,}\b/i,
  /["'](?:access_token|refresh_token|client_secret|password)["']\s*:\s*["'][^"'\s]{12,}/i,
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
];
let failures = 0;
for (const filename of unique) {
  if (/(?:^|\/)(?:\.env(?:\.|$)|access-token$|management-token$|config\.local\.|auth\.json$|credentials\.json$|remote-state\.json$|\.freebuff(?:\/|$))|\.(?:sqlite|db|pem|pfx|p12|key)(?:$|[.-])/i.test(filename)) {
    console.error(`Forbidden private filename: ${filename}`); failures++; continue;
  }
  const contents = [];
  if (existsSync(filename)) contents.push(readFileSync(filename));
  try {
    contents.push(execFileSync('git', ['show', `:${filename}`], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    if (error?.code === 'ENOBUFS') {
      console.error(`File too large to scan safely: ${filename}`); failures++; continue;
    }
    /* Untracked files have no index version. */
  }
  if (!contents.length) continue;
  if (contents.some(data => data.includes(0))) { console.error(`Unexpected binary file: ${filename}`); failures++; continue; }
  if (contents.some(data => patterns.some(pattern => pattern.test(data.toString('utf8'))))) { console.error(`Possible secret in ${filename}; value omitted.`); failures++; }
}
if (failures) process.exitCode = 1;
else console.log(`Secret checks passed for ${unique.length} files. Pattern scanning is not a complete security audit.`);
