/**
 * Host run module — agent-triggered command execution on the host.
 *
 * Registers the `host_run` delivery action. When Cortex emits a `host_run`
 * system message via its MCP tool, this handler spawns the requested
 * command on the host (Node child_process), collects stdout/stderr, and
 * notifies the agent with the result via notifyAgent().
 *
 * Use case: builds (e.g. `make build` in daylight-work/backend) that can't
 * run inside the container because rootless podman builds need newuidmap
 * which isn't available in unprivileged containers. Future use: any host
 * operation Cortex needs that doesn't fit the existing socket/git/file
 * surface (system service ops, cron edits, etc.).
 *
 * Trust boundary: messaging-group ACL. Cortex is already fully trusted
 * (push to all vmaz repos via SSH, restart the host, edit nanoclaw source),
 * so adding "run any host command" is a consistent capability — not a
 * meaningful escalation. No approval flow.
 *
 * Output is truncated to MAX_OUTPUT_BYTES per stream so a chatty build
 * doesn't blow up the inbound DB or the agent's context window.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { notifyAgent } from '../approvals/primitive.js';

const DEFAULT_CWD = '/var/home/vmaz/dev';
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 1800;
const MAX_OUTPUT_BYTES = 8192;

function truncate(buf: string, label: string): string {
  if (buf.length <= MAX_OUTPUT_BYTES) return buf;
  const head = buf.slice(0, MAX_OUTPUT_BYTES / 2);
  const tail = buf.slice(buf.length - MAX_OUTPUT_BYTES / 2);
  return `${head}\n... [${buf.length - MAX_OUTPUT_BYTES} bytes ${label} truncated] ...\n${tail}`;
}

registerDeliveryAction('host_run', async (content, session) => {
  const command = (content.command as string)?.trim();
  if (!command) {
    notifyAgent(session, '[host_run] failed: empty command');
    return;
  }

  const cwd = (content.cwd as string) || DEFAULT_CWD;
  if (!existsSync(cwd)) {
    notifyAgent(session, `[host_run] failed: cwd does not exist on host: ${cwd}`);
    return;
  }

  const timeoutS = Math.min(Math.max((content.timeout_seconds as number) || DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);

  log.info('host_run', { sessionId: session.id, command: command.slice(0, 200), cwd, timeoutS });
  const startedAt = Date.now();

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const child = spawn('bash', ['-lc', command], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000);
  }, timeoutS * 1000);

  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > MAX_OUTPUT_BYTES * 4) stdout = truncate(stdout, 'stdout');
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > MAX_OUTPUT_BYTES * 4) stderr = truncate(stderr, 'stderr');
  });

  await new Promise<void>((resolve) => {
    child.on('close', () => resolve());
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      resolve();
    });
  });

  clearTimeout(killTimer);

  const durationS = Math.round((Date.now() - startedAt) / 1000);
  const exit = child.exitCode ?? -1;
  const status = timedOut ? `KILLED after ${timeoutS}s timeout` : `exit=${exit}`;

  const finalStdout = truncate(stdout, 'stdout').trim();
  const finalStderr = truncate(stderr, 'stderr').trim();

  const parts = [`[host_run] ${status} duration=${durationS}s cwd=${cwd}`, `command: ${command}`];
  if (finalStdout) parts.push(`--- stdout ---\n${finalStdout}`);
  if (finalStderr) parts.push(`--- stderr ---\n${finalStderr}`);
  if (!finalStdout && !finalStderr) parts.push('(no output)');

  notifyAgent(session, parts.join('\n\n'));
});
