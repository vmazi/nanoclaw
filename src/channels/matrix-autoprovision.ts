/**
 * Matrix per-room auto-provisioning.
 *
 * When a PRIVILEGED user (owner / admin) brings Cortex into a new Matrix room,
 * the room is automatically wired to the SAME agent group that serves the
 * user's DM — instead of the message being dropped / escalated to a channel-
 * registration card.
 *
 * Two entry points, both funnel through `provisionMatrixRoom`:
 *   1. On autojoin — when Cortex accepts an invite from an allow-listed user
 *      (src/channels/matrix.ts onRoomInvite), so the room is wired BEFORE any
 *      message. This matters because a plain (non-@mention) first message in an
 *      unwired group room is dropped by the router.
 *   2. Router auto-provision hook — a mention/DM on an unwired messaging group
 *      (fallback for rooms Cortex was already in before this shipped).
 *
 * Design: one shared Cortex brain, each room its own session (session_mode
 * 'shared' → one session per messaging group). engage_mode 'pattern'/'.' so
 * Cortex replies to every message (personal assistant in org rooms).
 */
import { randomUUID } from 'node:crypto';

import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../db/messaging-groups.js';
import { log } from '../log.js';
import { canAccessAgentGroup } from '../modules/permissions/access.js';
import { setAutoProvisionHook } from '../router.js';
import type { InboundEvent } from './adapter.js';
import type { MessagingGroup } from '../types.js';

/** Reasons that count as "privileged enough" to auto-provision a new room. */
const PRIVILEGED_REASONS = new Set(['owner', 'global_admin', 'admin_of_group']);

/**
 * Wire a Matrix room to the sender's agent group (Cortex). Creates the
 * messaging group if it doesn't exist yet. Returns true if a new wiring was
 * created. `senderId` and `roomPlatformId` both carry the `matrix:` prefix.
 */
export function provisionMatrixRoom(roomPlatformId: string, isGroup: boolean, senderId: string): boolean {
  if (roomPlatformId === senderId) return false; // the sender's own DM — never here

  // Target agent group = whatever serves the sender's DM (Cortex).
  const dmMg = getMessagingGroupByPlatform('matrix', senderId);
  if (!dmMg) return false;
  const template = getMessagingGroupAgents(dmMg.id)[0];
  if (!template) return false;

  // Gate: only owners/admins auto-provision.
  const access = canAccessAgentGroup(senderId, template.agent_group_id);
  if (!access.allowed || !PRIVILEGED_REASONS.has(access.reason)) return false;

  // Get or create the room's messaging group.
  let mg = getMessagingGroupByPlatform('matrix', roomPlatformId);
  if (mg) {
    if (getMessagingGroupAgents(mg.id).length > 0) return false; // already wired
  } else {
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createMessagingGroup({
      id: mgId,
      channel_type: 'matrix',
      platform_id: roomPlatformId,
      name: null,
      is_group: isGroup ? 1 : 0,
      unknown_sender_policy: 'request_approval',
      denied_at: null,
      created_at: new Date().toISOString(),
    });
    mg = getMessagingGroupByPlatform('matrix', roomPlatformId);
    if (!mg) return false;
  }

  createMessagingGroupAgent({
    id: randomUUID(),
    messaging_group_id: mg.id,
    agent_group_id: template.agent_group_id,
    // Reply to ALL messages in the room, not just @-mentions (personal
    // assistant in org rooms). 'pattern' + '.' is the "always" flavor.
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });

  log.info('Matrix: provisioned room → agent group', {
    platformId: roomPlatformId,
    agentGroupId: template.agent_group_id,
    isGroup,
    grantedVia: access.reason,
  });
  return true;
}

/** Router hook — mention/DM on an unwired messaging group. */
async function matrixAutoProvisionHook(mg: MessagingGroup, event: InboundEvent): Promise<boolean> {
  if (mg.channel_type !== 'matrix') return false;
  let senderId: string | undefined;
  try {
    senderId = (JSON.parse(event.message.content) as { senderId?: string }).senderId;
  } catch {
    return false;
  }
  if (!senderId) return false;
  return provisionMatrixRoom(mg.platform_id, mg.is_group === 1, senderId);
}

setAutoProvisionHook(matrixAutoProvisionHook);
