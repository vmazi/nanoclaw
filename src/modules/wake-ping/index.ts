/**
 * Wake-ping text builder — shared between scripts/wake-ping.ts (host restart)
 * and container-restart.ts (container-only restart) so both paths produce the
 * same "I'm back online" announcement.
 */
import { execSync } from 'node:child_process';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { pickApprover } from '../approvals/primitive.js';
import { ensureUserDm } from '../permissions/user-dm.js';

export function getGitRev(): string {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim() ? '+dirty' : '';
    return `${branch}@${sha}${dirty}`;
  } catch {
    return 'unknown';
  }
}

export function buildWakePingText(channel = 'Signal'): string {
  const rev = getGitRev();
  const time = new Date().toLocaleTimeString();
  return (
    `[wake-ping] You just came online. Send EXACTLY this DM to vmaz on ${channel} — ` +
    `do NOT try to verify the revision yourself from /app (that's the container, not the host repo); ` +
    `the rev below was captured on the host where the actual nanoclaw repo lives:\n\n` +
    `<message to="vmaz">🧠\n🟢 Cortex online @ ${time} — rev ${rev}</message>`
  );
}

/**
 * Announce "Cortex online" straight into the operator's DM on every channel
 * they're reachable on, host-side.
 *
 * This deliberately does not go through an agent session. The previous
 * approach injected an on_wake row into "the newest session directory" and
 * relied on that container waking and composing the message itself, which
 * failed three ways at once: the newest directory is not necessarily the room
 * anyone is watching, on_wake rows are only visible on a container's first
 * poll, and a wedged session swallows the row with no trace. Delivering here
 * uses the same resolution approvals use — the one path known to reach the
 * operator reliably.
 *
 * Best-effort throughout: a restart is never blocked or failed on the
 * announcement.
 */
export async function postStartupPingToUserDms(agentGroupId: string | null = null): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;

  const text = `🧠 🟢 Cortex online @ ${new Date().toLocaleTimeString()} — rev ${getGitRev()}`;
  // One operator can be an approver on several channels; dedupe by the
  // resolved DM so they get one ping per channel, not one per role grant.
  const delivered = new Set<string>();

  for (const userId of pickApprover(agentGroupId)) {
    let mg;
    try {
      mg = await ensureUserDm(userId);
    } catch (err) {
      log.error('startup ping: DM resolution failed', { userId, err });
      continue;
    }
    if (!mg) continue;

    const key = `${mg.channel_type}:${mg.platform_id}`;
    if (delivered.has(key)) continue;
    delivered.add(key);

    try {
      await adapter.deliver(mg.channel_type, mg.platform_id, null, 'chat', JSON.stringify({ text }));
    } catch (err) {
      log.error('startup ping: delivery failed', { channelType: mg.channel_type, err });
    }
  }

  log.info('Startup ping sent', { destinations: delivered.size });
}
