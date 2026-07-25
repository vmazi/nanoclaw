/**
 * Wake-ping text builder — shared between scripts/wake-ping.ts (host restart)
 * and container-restart.ts (container-only restart) so both paths produce the
 * same "I'm back online" announcement.
 */
import { execSync } from 'node:child_process';
import { readEnvFile } from '../../env.js';

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
 * Post the same "Cortex online" announcement into the Stoat #startup-ping
 * channel, straight over the REST API as the bot. Best-effort: any missing
 * config (no token / no channel) or network error is swallowed so a restart is
 * never blocked on the announcement. Runs host-side in both the host-restart
 * (scripts/wake-ping.ts) and container-restart paths.
 */
export async function postStartupPingToStoat(): Promise<void> {
  const env = readEnvFile(['STOAT_BOT_TOKEN', 'STOAT_API_URL', 'STOAT_STARTUP_PING_CHANNEL']);
  const token = process.env.STOAT_BOT_TOKEN || env.STOAT_BOT_TOKEN;
  const channel = process.env.STOAT_STARTUP_PING_CHANNEL || env.STOAT_STARTUP_PING_CHANNEL;
  if (!token || !channel) return;
  const apiUrl = (process.env.STOAT_API_URL || env.STOAT_API_URL || 'https://sig.borgorg.org/api').replace(/\/$/, '');
  const content = `🧠 🟢 Cortex online @ ${new Date().toLocaleTimeString()} — rev ${getGitRev()}`;
  try {
    await fetch(`${apiUrl}/channels/${channel}/messages`, {
      method: 'POST',
      headers: {
        'X-Bot-Token': token,
        'Content-Type': 'application/json',
        'Idempotency-Key': `startup-${Date.now()}`,
      },
      body: JSON.stringify({ content }),
    });
  } catch {
    /* best-effort — never block startup on the announcement */
  }
}
