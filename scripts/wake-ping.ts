/**
 * Inject an `on_wake` row into Cortex's most recent session so the next
 * container spawn introduces itself to vmaz on Signal — proves end-to-end
 * agentic operation after every start-nanoclaw.sh invocation.
 */
import Database from 'better-sqlite3';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function gitRev(): string {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim() ? '+dirty' : '';
    return `${branch}@${sha}${dirty}`;
  } catch {
    return 'unknown';
  }
}

const CORTEX_AG = 'ag-1778779779683-jozrcq';
const VMAZ_SIGNAL = '+16098199277';
const SESS_ROOT = join('data', 'v2-sessions', CORTEX_AG);

if (!existsSync(SESS_ROOT)) {
  console.error(`wake-ping: no agent-group dir at ${SESS_ROOT}`);
  process.exit(1);
}

const sessions = readdirSync(SESS_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith('sess-'))
  .map((d) => d.name)
  .sort();

if (sessions.length === 0) {
  console.error(`wake-ping: no sessions under ${SESS_ROOT}`);
  process.exit(1);
}

const inbound = join(SESS_ROOT, sessions[sessions.length - 1], 'inbound.db');
if (!existsSync(inbound)) {
  console.error(`wake-ping: missing ${inbound}`);
  process.exit(1);
}

const db = new Database(inbound);

const { m } = db
  .prepare('SELECT COALESCE(MAX(seq), -2) AS m FROM messages_in WHERE seq % 2 = 0')
  .get() as { m: number };
const seq = m + 2;

const rev = gitRev();
const content = JSON.stringify({
  text: `[wake-ping] You just came online. Send EXACTLY this DM to vmaz on Signal — do NOT try to verify the revision yourself from /app (that's the container, not the host repo); the rev below was captured on the host where the actual nanoclaw repo lives:\n\n<message to="vmaz">🟢 Cortex online @ ${new Date().toLocaleTimeString()} — rev ${rev}</message>`,
  sender: 'system',
  senderId: 'system',
  senderName: 'System',
  isFromMe: false,
});

db.prepare(
  `INSERT INTO messages_in
   (id, seq, kind, timestamp, status, trigger, on_wake, channel_type, thread_id, platform_id, content)
   VALUES (?, ?, 'chat', ?, 'pending', 1, 1, 'signal', '', ?, ?)`,
).run(randomUUID(), seq, new Date().toISOString(), VMAZ_SIGNAL, content);

console.error(`wake-ping injected seq=${seq} into ${inbound}`);
