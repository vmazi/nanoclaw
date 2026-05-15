/**
 * Host run module — agent-triggered command execution on the host.
 *
 * Two-stage flow: the container writes a `host_run` system message via its
 * MCP tool; the delivery action below validates input against the allowlist
 * and queues an admin approval via requestApproval(). The approval handler
 * (registered on the same `host_run` action) does the actual child_process
 * spawn after the admin approves, and notifies the agent with the result.
 *
 * Allowlist: only image/compose builds are accepted today —
 *   `podman build`, `docker build`, `podman compose build|run`,
 *   `docker compose build|run`
 * optionally prefixed with a single `cd <abs-path> && `. No shell chaining.
 * Other host operations should grow dedicated MCP tools rather than ride
 * on host_run.
 *
 * Self-restart guard: commands that would SIGTERM the host before delivery
 * can be acked (e.g. `systemctl --user restart nanoclaw`) are refused with
 * a pointer to the `restart_host` MCP tool, which exits cleanly.
 *
 * Output is truncated to MAX_OUTPUT_BYTES per stream so a chatty build
 * doesn't blow up the inbound DB or the agent's context window.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getAgentGroup } from '../../db/agent-groups.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { notifyAgent, registerApprovalHandler, requestApproval, type ApprovalHandler } from '../approvals/index.js';

const DEFAULT_CWD = '/var/home/vmaz/dev';
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 1800;
const MAX_OUTPUT_BYTES = 8192;

// Commands that would terminate the host process before this handler can
// markDelivered() the outbound row. Without this guard, the row stays
// pending, the host respawns, replays the same command, and the loop never
// drains.
const SELF_KILL_PATTERN =
  /\b(systemctl(\s+--user)?\s+(restart|stop|reload|kill)\s+\S*nanoclaw|launchctl\s+(unload|stop|kickstart)[^\n]*com\.nanoclaw|pkill[^\n]*nanoclaw)\b/i;

// Top-level verbs the agent is permitted to invoke through host_run.
const ALLOWED_VERB =
  /^(podman\s+build|docker\s+build|podman\s+compose\s+(build|run)|docker\s+compose\s+(build|run))(\s|$)/i;

// Shell control operators that could chain another command after the
// allowed verb. A single `cd <abs> && ` prefix is stripped before this
// check, so any remaining `&&` is rejected too.
const SHELL_CONTROL = /(\|\||&&|;|`|\$\()/;
const BARE_PIPE = /(^|\s)\|(\s|$)/;
const CD_PREFIX = /^cd\s+(\/[^\s;&|`$()]+)\s+&&\s+/;

export function wouldKillHostProcess(command: string): boolean {
  return SELF_KILL_PATTERN.test(command);
}

export function isAllowedHostCommand(command: string): boolean {
  let cmd = command.trim();
  const cdMatch = cmd.match(CD_PREFIX);
  if (cdMatch) cmd = cmd.slice(cdMatch[0].length);
  if (!ALLOWED_VERB.test(cmd)) return false;
  if (SHELL_CONTROL.test(cmd)) return false;
  if (BARE_PIPE.test(cmd)) return false;
  return true;
}

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

  if (wouldKillHostProcess(command)) {
    notifyAgent(
      session,
      '[host_run] refused: command would terminate the nanoclaw host process before this request can be acknowledged, which causes an infinite replay loop on respawn. Use the `restart_host` MCP tool instead — it acks delivery before exiting, and systemd picks the host back up.',
    );
    return;
  }

  if (!isAllowedHostCommand(command)) {
    notifyAgent(
      session,
      '[host_run] refused: only image/compose builds are allowed. Permitted (optionally prefixed with `cd <abs-path> &&`):\n  • podman build ...\n  • docker build ...\n  • podman compose build|run ...\n  • docker compose build|run ...\nNo shell chaining (`;`, `&&` other than the cd prefix, `||`, `|`, backticks, `$(...)`).',
    );
    return;
  }

  const cwd = (content.cwd as string) || DEFAULT_CWD;
  if (!existsSync(cwd)) {
    notifyAgent(session, `[host_run] failed: cwd does not exist on host: ${cwd}`);
    return;
  }

  const timeoutS = Math.min(Math.max((content.timeout_seconds as number) || DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);

  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, '[host_run] failed: agent group not found.');
    return;
  }

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'host_run',
    payload: { command, cwd, timeoutS },
    title: 'Host Command Approval',
    question: `Agent "${agentGroup.name}" wants to run on the host:\n\`${command}\`\ncwd: ${cwd}\ntimeout: ${timeoutS}s`,
  });
});

const applyHostRun: ApprovalHandler = async ({ session, payload, notify }) => {
  const command = payload.command as string;
  const cwd = payload.cwd as string;
  const timeoutS = payload.timeoutS as number;

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

  notify(parts.join('\n\n'));
};

registerApprovalHandler('host_run', applyHostRun);
