/**
 * `create_worktree_agent` delivery-action handler.
 *
 * Creates a git worktree for a branch, patches its .env with dedicated ports,
 * spins up a new agent group with the worktree mounted read-write, wires
 * bidirectional destinations, and notifies the requesting agent.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { updateContainerConfigJson } from '../../db/container-configs.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { addAllowedRoot } from '../mount-security/index.js';
import { createDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

/** Replace or append an env var line in a .env file string. */
function setEnvVar(envContent: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(envContent)) {
    return envContent.replace(re, `${key}=${value}`);
  }
  return envContent.trimEnd() + `\n${key}=${value}\n`;
}

/** Build the CLAUDE.local.md seed content for the new worktree agent. */
function buildLocalMd(
  branch: string,
  worktreePath: string,
  containerPath: string,
  djangoPort: number,
  postgresPort: number,
  extraInstructions: string | null,
): string {
  const lines = [
    `# Worktree Agent`,
    ``,
    `## Branch`,
    `${branch}`,
    ``,
    `## Paths`,
    `- Host worktree: \`${worktreePath}\``,
    `- Container path: \`${containerPath}\``,
    ``,
    `## Ports`,
    `| Service  | Host port |`,
    `|----------|-----------|`,
    `| Django   | ${djangoPort} |`,
    `| Postgres | ${postgresPort} |`,
    ``,
    `## Working directory`,
    `Your code lives at \`${containerPath}\`. Run \`make up\` there to start the stack.`,
  ];

  if (extraInstructions) {
    lines.push('', '## Additional instructions', extraInstructions);
  }

  return lines.join('\n') + '\n';
}

export async function handleCreateWorktreeAgent(
  content: Record<string, unknown>,
  session: Session,
): Promise<void> {
  const requestId = content.requestId as string;
  const branch = content.branch as string;
  const baseRepo = content.baseRepo as string;
  const djangoPort = content.djangoPort as number;
  const postgresPort = content.postgresPort as number;
  const instructions = (content.instructions as string | null) ?? null;

  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    notifyAgent(session, `create_worktree_agent failed: source agent group not found.`);
    log.warn('create_worktree_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id });
    return;
  }

  // Derive slug: branch → safe lowercase alphanumeric-and-dash
  const branchSlug = branch
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

  const repoName = path.basename(baseRepo);
  const worktreePath =
    (content.worktreePath as string | null) ??
    path.join(path.dirname(baseRepo), `${repoName}-${branchSlug}`);

  // Container-relative path (relative to /workspace/extra/)
  const containerRelPath = `${repoName}-${branchSlug}`;
  const containerPath = `/workspace/extra/${containerRelPath}`;

  // Collision check in creator's destination namespace
  const agentName = `daylight-${branchSlug}`;
  const localName = normalizeName(agentName);
  if (getDestinationByName(sourceGroup.id, localName)) {
    notifyAgent(
      session,
      `Cannot create worktree agent "${agentName}": you already have a destination named "${localName}".`,
    );
    return;
  }

  // 1. Create git worktree
  try {
    execSync(`git -C "${baseRepo}" worktree add "${worktreePath}" "${branch}"`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notifyAgent(session, `create_worktree_agent failed to create worktree: ${msg}`);
    log.error('create_worktree_agent: git worktree add failed', { branch, baseRepo, worktreePath, err });
    return;
  }

  // 2. Copy .env and patch ports
  const envSrc = path.join(baseRepo, '.env');
  const envDst = path.join(worktreePath, '.env');
  if (fs.existsSync(envSrc)) {
    let envContent = fs.readFileSync(envSrc, 'utf-8');
    envContent = setEnvVar(envContent, 'DJANGO_HOST_PORT', String(djangoPort));
    envContent = setEnvVar(envContent, 'POSTGRES_HOST_PORT', String(postgresPort));
    fs.writeFileSync(envDst, envContent);
  }

  // 3. Ensure the worktree's parent dir is in the mount allowlist
  addAllowedRoot({
    path: path.dirname(worktreePath),
    allowReadWrite: true,
    description: `Worktrees for ${repoName}`,
  });

  // 4. Derive a globally unique folder name
  let folder = localName;
  let folderSuffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${localName}-${folderSuffix}`;
    folderSuffix++;
  }

  const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const newGroup: AgentGroup = {
    id: agentGroupId,
    name: agentName,
    folder,
    agent_provider: null,
    created_at: now,
  };

  // 5. Create agent group + filesystem (with seeded CLAUDE.local.md)
  createAgentGroup(newGroup);
  const localMd = buildLocalMd(branch, worktreePath, containerPath, djangoPort, postgresPort, instructions);
  initGroupFilesystem(newGroup, { instructions: localMd });

  // 6. Wire the worktree mount (containerPath is relative to /workspace/extra/)
  updateContainerConfigJson(agentGroupId, 'additional_mounts', [
    { hostPath: worktreePath, containerPath: containerRelPath, readonly: false },
  ]);

  // 7. Bidirectional destinations
  createDestination({
    agent_group_id: sourceGroup.id,
    local_name: localName,
    target_type: 'agent',
    target_id: agentGroupId,
    created_at: now,
  });

  let parentName = 'parent';
  let parentSuffix = 2;
  while (getDestinationByName(agentGroupId, parentName)) {
    parentName = `parent-${parentSuffix}`;
    parentSuffix++;
  }
  createDestination({
    agent_group_id: agentGroupId,
    local_name: parentName,
    target_type: 'agent',
    target_id: sourceGroup.id,
    created_at: now,
  });

  // 8. Project destinations into the running parent container
  writeDestinations(session.agent_group_id, session.id);

  // 9. Notify the parent agent
  notifyAgent(
    session,
    `Worktree agent "${localName}" is ready.\n` +
      `Branch: ${branch}\n` +
      `Worktree: ${worktreePath}\n` +
      `Django port: ${djangoPort} · Postgres port: ${postgresPort}\n` +
      `Send it tasks with <message to="${localName}">...</message>.`,
  );

  log.info('Worktree agent created', {
    agentGroupId,
    agentName,
    localName,
    folder,
    branch,
    worktreePath,
    djangoPort,
    postgresPort,
    parent: sourceGroup.id,
  });

  void requestId;
}
