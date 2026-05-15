/**
 * Host run MCP tool — request command execution on the host.
 *
 * Use this when an operation can't run inside the container because the
 * container is unprivileged in ways the host isn't. Concrete examples:
 *   - `podman build` (and anything downstream like `docker compose build`,
 *     `make build`) — fails inside the container because rootless podman
 *     needs newuidmap, which the unprivileged container can't run.
 *   - Any `systemctl --user` operation that needs to manage host services.
 *   - One-off shell commands a person would type in their terminal.
 *
 * Fire-and-forget — the tool writes a system action and returns immediately
 * with an ack. The host runs the command, captures stdout/stderr, and
 * delivers the result back via a system chat message you'll see on your
 * next poll iteration. Output is truncated to about 8KB per stream.
 *
 * Default cwd is /var/home/vmaz/dev (the host's parent dev dir). Pass an
 * absolute `cwd` to run somewhere specific (e.g.
 * /var/home/vmaz/dev/daylight-work/backend for `make build`).
 *
 * Default timeout is 10 minutes; max 30. Long-running builds are fine.
 *
 * Use sparingly — operations you can do inside the container (file edits,
 * git, docker run/ps via the mounted socket, etc.) should stay there for
 * lower latency and clearer attribution.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const hostRun: McpToolDefinition = {
  tool: {
    name: 'host_run',
    description:
      "Run a container/compose build or service management command on the host (outside your container). Restricted to: `podman build`, `docker build`, `podman compose build|run|up|down|start|stop|restart|ps`, `docker compose build|run|up|down|start|stop|restart|ps`, optionally prefixed with a single `cd <abs-path> &&`. Anything else (including `make build`, `./build.sh`, shell-chained commands with `;`/`&&`/`|`, command substitution) is refused. Use case: rootless podman builds that can't run inside the unprivileged container because they need newuidmap, plus starting/stopping compose services. Every request goes through an admin approve/deny on the user's DM channel — there is a human-in-the-loop delay before the command actually runs. Fire-and-forget: returns an ack immediately; the result (or refusal) arrives later as a system chat message. Default cwd /var/home/vmaz/dev; default timeout 600s, max 1800s. For host restarts use the `restart_host` MCP tool instead — never try to systemctl/launchctl/pkill nanoclaw through this tool.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to run on the host (will run under bash -lc)' },
        cwd: { type: 'string', description: 'Absolute working directory on the host (default /var/home/vmaz/dev)' },
        timeout_seconds: {
          type: 'number',
          description: 'Wall-clock kill timer in seconds (default 600, max 1800)',
        },
      },
      required: ['command'],
    },
  },
  async handler(args) {
    const command = (args.command as string | undefined)?.trim();
    if (!command) return err('command is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'host_run',
        command,
        cwd: args.cwd,
        timeout_seconds: args.timeout_seconds,
      }),
    });

    return ok(
      `host_run submitted (id ${requestId}). Result will arrive as a system chat message when the command completes.`,
    );
  },
};

registerTools([hostRun]);
