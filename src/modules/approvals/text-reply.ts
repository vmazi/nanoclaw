/**
 * Text-fallback for approve/deny on channels without chat-sdk buttons.
 *
 * When `requestApproval` delivers via a native channel (Signal, etc.), the
 * payload includes a plain-text fallback ("Reply approve or deny"). This
 * interceptor catches those replies and dispatches them as if a chat-sdk
 * button had been clicked.
 *
 * Heuristic: if the inbound message body trims to exactly `approve` or
 * `deny` (case-insensitive), look up the most recent `pending` approval
 * tied to the messaging group of the inbound channel, then dispatch a
 * ResponsePayload to the registered response handlers. The first handler
 * that claims (returns true) resolves the approval; downstream routing
 * is skipped.
 *
 * On ambiguity (two pending approvals on the same channel), the newest
 * wins. That matches typical UX — you reply to the last thing you saw.
 *
 * Single-shot only. A separate refactor is needed if we ever want
 * multi-approval batch replies on text-only channels.
 */
import type { InboundEvent } from '../../channels/adapter.js';
import { getDb } from '../../db/connection.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { getResponseHandlers } from '../../response-registry.js';
import { setMessageInterceptor } from '../../router.js';

const TEXT_RE = /^\s*(approve|deny|reject)\s*[.!]*\s*$/i;

setMessageInterceptor(async (event: InboundEvent): Promise<boolean> => {
  let text: string;
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    text = typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return false;
  }

  const match = TEXT_RE.exec(text);
  if (!match) return false;
  const value = match[1].toLowerCase() === 'approve' ? 'approve' : 'reject';

  const mg = getMessagingGroupByPlatform(event.channelType, event.platformId);
  if (!mg) return false;

  // Look up the most recent pending approval whose session is bound to this
  // messaging group.
  const row = getDb()
    .prepare(
      `SELECT pa.approval_id
       FROM pending_approvals pa
       JOIN sessions s ON s.id = pa.session_id
       WHERE s.messaging_group_id = ?
         AND pa.status = 'pending'
       ORDER BY pa.created_at DESC
       LIMIT 1`,
    )
    .get(mg.id) as { approval_id: string } | undefined;

  if (!row) return false;

  let userId: string | null = null;
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    if (typeof parsed.senderId === 'string') userId = parsed.senderId;
  } catch {
    /* leave null */
  }

  log.info('Text-reply approval dispatch', {
    approvalId: row.approval_id,
    value,
    channelType: event.channelType,
    userId,
  });

  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler({
        questionId: row.approval_id,
        value,
        userId,
        channelType: event.channelType,
        platformId: event.platformId,
        threadId: event.threadId,
      });
      if (claimed) return true;
    } catch (err) {
      log.error('Approval response handler threw', { approvalId: row.approval_id, err });
    }
  }

  // No handler claimed — still consume the message so the agent doesn't see
  // the bare "approve" reply.
  return true;
});
