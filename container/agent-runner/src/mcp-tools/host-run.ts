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
      "Run a shell command on the host (outside your container). Use for operations that need host privileges your container lacks — most commonly builds (`make build`, `docker compose build`, `podman build`) which require newuidmap. Fire-and-forget: returns an ack immediately; the actual stdout/stderr arrives later as a system chat message in your inbox. Default cwd is /var/home/vmaz/dev; pass `cwd` for a specific subdir. Default timeout 600s, max 1800s. NEVER use this to restart, stop, or kill the nanoclaw host service (e.g. `systemctl --user restart cortex-nanoclaw`, `launchctl kickstart ... com.nanoclaw`, `pkill nanoclaw`) — the host dies before it can ack delivery and replays the command on every respawn, creating an infinite loop. Use the `restart_host` MCP tool instead for host restarts (it acks delivery first), or `ncl groups restart` from inside the container if you only need your container bounced.",
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
