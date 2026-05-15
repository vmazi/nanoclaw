/**
 * Host control MCP tools — agent-triggered restart of the nanoclaw host.
 *
 * `restart_host` is fire-and-forget: the tool writes a system action row and
 * returns. The host's host-control delivery handler touches a flag file and
 * SIGTERMs itself. The start-nanoclaw.sh wrapper loop sees the flag and
 * re-execs the start script — git pull, rebuild if stale, wake-ping, then
 * the host comes back up. The container is killed as part of the host's
 * graceful shutdown and respawned by the new host on the next user message.
 *
 * Use this when the user asks to restart, reload, redeploy, or pull the
 * latest nanoclaw code.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const restartHost: McpToolDefinition = {
  tool: {
    name: 'restart_host',
    description:
      'Restart the nanoclaw host process. Triggers a graceful shutdown of the host (which kills your container) followed by a re-exec of start-nanoclaw.sh: git pull from origin/cortex-main, rebuild if stale, then start back up. Use when the user asks to restart, reload, redeploy, or pick up the latest nanoclaw code. Fire-and-forget — your container will be killed as part of the restart, so send any acknowledgement to the user BEFORE calling this tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string', description: 'Why the restart was requested (logged on the host)' },
      },
    },
  },
  async handler(args) {
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'restart_host',
        reason: (args.reason as string) || '',
      }),
    });
    return ok('Restart request submitted. The host will SIGTERM and re-exec; this container will be killed.');
  },
};

registerTools([restartHost]);
