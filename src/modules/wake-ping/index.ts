/**
 * Wake-ping text builder — shared between scripts/wake-ping.ts (host restart)
 * and container-restart.ts (container-only restart) so both paths produce the
 * same "I'm back online" announcement.
 */
import { execSync } from 'node:child_process';

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

export function buildWakePingText(): string {
  const rev = getGitRev();
  const time = new Date().toLocaleTimeString();
  return (
    `[wake-ping] You just came online. Send EXACTLY this DM to vmaz on Signal — ` +
    `do NOT try to verify the revision yourself from /app (that's the container, not the host repo); ` +
    `the rev below was captured on the host where the actual nanoclaw repo lives:\n\n` +
    `<message to="vmaz">🧠\n🟢 Cortex online @ ${time} — rev ${rev}</message>`
  );
}
