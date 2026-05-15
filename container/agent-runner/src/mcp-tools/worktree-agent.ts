/**
 * `create_worktree_agent` MCP tool.
 *
 * Creates a git worktree for a branch, spins up a dedicated NanoClaw agent
 * container with the worktree mounted, and wires bidirectional destinations.
 * Fire-and-forget — the host sends a notification when the agent is ready.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const createWorktreeAgent: McpToolDefinition = {
  tool: {
    name: 'create_worktree_agent',
    description:
      'Create a git worktree for a branch and spin up a dedicated agent container to work on it. ' +
      "The worktree is mounted read-write inside the new agent's container. " +
      'The agent knows its branch, host path, ports, and compose project name from the start. ' +
      "Fire-and-forget — you get a notification when the agent is ready.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        branch: {
          type: 'string',
          description:
            'Branch name to check out in the worktree (must already exist locally or on the remote)',
        },
        base_repo: {
          type: 'string',
          description:
            'Absolute host path to the base git repository (e.g. /var/home/vmaz/dev/daylight-work/backend)',
        },
        worktree_path: {
          type: 'string',
          description:
            'Absolute host path where the worktree is created. Defaults to <base_repo_parent>/<repo_name>-<branch_slug>.',
        },
        django_port: {
          type: 'number',
          description: 'Host port for the Django dev server in this worktree (default: 8003)',
        },
        postgres_port: {
          type: 'number',
          description: 'Host port for the PostgreSQL dev database in this worktree (default: 5435)',
        },
        instructions: {
          type: 'string',
          description: "Extra context appended to the agent's CLAUDE.local.md",
        },
      },
      required: ['branch', 'base_repo'],
    },
  },
  async handler(args) {
    const branch = String(args.branch ?? '').trim();
    const baseRepo = String(args.base_repo ?? '').trim();
    if (!branch) return err('branch is required');
    if (!baseRepo) return err('base_repo is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_worktree_agent',
        requestId,
        branch,
        baseRepo,
        worktreePath: args.worktree_path ? String(args.worktree_path) : null,
        djangoPort: typeof args.django_port === 'number' ? args.django_port : 8003,
        postgresPort: typeof args.postgres_port === 'number' ? args.postgres_port : 5435,
        instructions: args.instructions ? String(args.instructions) : null,
      }),
    });

    return ok(
      `Worktree agent request submitted for branch "${branch}". ` +
        "The host will create the worktree and spin up the agent — you'll get a notification when it's ready.",
    );
  },
};

registerTools([createWorktreeAgent]);
