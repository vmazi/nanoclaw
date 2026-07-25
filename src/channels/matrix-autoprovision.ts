/**
 * Matrix per-room auto-provisioning.
 *
 * Registers the router's auto-provision hook so that when a PRIVILEGED sender
 * (owner / admin) is seen in a brand-new Matrix room that has no agent wiring
 * yet, the room is automatically wired to the SAME agent group that serves the
 * sender's DM (Cortex) — instead of escalating to the channel-registration
 * card.
 *
 * Design (decided with the user):
 *   - One shared brain: every Matrix room wires to the sender's DM agent group,
 *     so memory/workspace/mounts/personality are shared across all rooms.
 *   - Own session per room: the wiring uses session_mode='shared', which yields
 *     exactly one session per messaging group — and each room IS its own
 *     messaging group — so every room gets its own session container.
 *   - engage_mode='pattern' / engage_pattern='.': Cortex replies to EVERY message
 *     in the room (it's a personal assistant and the rooms are org spaces where
 *     it should always be engaged), not just @-mentions.
 *
 * Non-privileged senders fall through to the normal drop / registration path,
 * so this does not widen access — it only removes the manual wiring step for
 * the owner's own new rooms.
 */
import { randomUUID } from 'node:crypto';

import {
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  createMessagingGroupAgent,
} from '../db/messaging-groups.js';
import { log } from '../log.js';
import { canAccessAgentGroup } from '../modules/permissions/access.js';
import { setAutoProvisionHook } from '../router.js';
import type { InboundEvent } from './adapter.js';
import type { MessagingGroup } from '../types.js';

/** Reasons that count as "privileged enough" to auto-provision a new room. */
const PRIVILEGED_REASONS = new Set(['owner', 'global_admin', 'admin_of_group']);

async function matrixAutoProvision(mg: MessagingGroup, event: InboundEvent): Promise<boolean> {
  if (mg.channel_type !== 'matrix') return false;

  let senderId: string | undefined;
  try {
    senderId = (JSON.parse(event.message.content) as { senderId?: string }).senderId;
  } catch {
    return false;
  }
  if (!senderId) return false;

  // The sender's own DM is the template + never needs provisioning here.
  if (mg.platform_id === senderId) return false;

  // Resolve the target agent group from the sender's DM wiring (Cortex).
  const dmMg = getMessagingGroupByPlatform('matrix', senderId);
  if (!dmMg) return false;
  const template = getMessagingGroupAgents(dmMg.id)[0];
  if (!template) return false;

  // Gate: only owners/admins auto-provision. Members fall through.
  const access = canAccessAgentGroup(senderId, template.agent_group_id);
  if (!access.allowed || !PRIVILEGED_REASONS.has(access.reason)) return false;

  createMessagingGroupAgent({
    id: randomUUID(),
    messaging_group_id: mg.id,
    agent_group_id: template.agent_group_id,
    // Respond to ALL messages in the room (not just @-mentions): Cortex is a
    // personal assistant and the rooms are org spaces where it should always be
    // engaged. engage_mode='pattern' with engage_pattern='.' is the "always"
    // flavor (see evaluateEngage). DMs already reply to everything.
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });

  log.info('Matrix: auto-provisioned new room → agent group', {
    messagingGroupId: mg.id,
    platformId: mg.platform_id,
    agentGroupId: template.agent_group_id,
    isGroup: mg.is_group === 1,
    grantedVia: access.reason,
  });
  return true;
}

setAutoProvisionHook(matrixAutoProvision);
