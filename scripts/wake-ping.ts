/**
 * Inject an `on_wake` row into Cortex's most recent session(s) so the next
 * container spawn introduces itself to vmaz — proves end-to-end agentic
 * operation after every start-nanoclaw.sh invocation.
 *
 * Pings BOTH channels Cortex serves: the Signal DM and the Matrix DM. Each is
 * a distinct agent group with its own sessions and its own "vmaz" destination,
 * so the `<message to="vmaz">` directive resolves to the right chat in each.
 * Targets are handled independently — a missing/empty session dir for one
 * channel never blocks the other.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildWakePingText } from '../src/modules/wake-ping/index.js';

interface WakeTarget {
  label: string; // human channel name, e.g. "Signal" / "Matrix"
  agentGroupId: string; // agent group folder under data/v2-sessions/
  channelType: string; // messages_in.channel_type
  platformId: string; // messages_in.platform_id (delivery address)
}

const TARGETS: WakeTarget[] = [
  {
    label: 'Signal',
    agentGroupId: 'ag-1778779779683-jozrcq',
    channelType: 'signal',
    platformId: '+16098199277',
  },
  {
    label: 'Matrix',
    agentGroupId: '88bf943b-fdbb-4501-8826-fa19b3c07ff4',
    channelType: 'matrix',
    platformId: 'matrix:@vmaz:matrix.borgorg.org',
  },
];

function injectWake(target: WakeTarget): void {
  const sessRoot = join('data', 'v2-sessions', target.agentGroupId);
  if (!existsSync(sessRoot)) {
    console.error(`wake-ping[${target.label}]: no agent-group dir at ${sessRoot} — skipping`);
    return;
  }

  const sessions = readdirSync(sessRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('sess-'))
    .map((d) => d.name)
    .sort();

  if (sessions.length === 0) {
    console.error(`wake-ping[${target.label}]: no sessions under ${sessRoot} — skipping`);
    return;
  }

  const inbound = join(sessRoot, sessions[sessions.length - 1], 'inbound.db');
  if (!existsSync(inbound)) {
    console.error(`wake-ping[${target.label}]: missing ${inbound} — skipping`);
    return;
  }

  const db = new Database(inbound);
  try {
    const { m } = db.prepare('SELECT COALESCE(MAX(seq), -2) AS m FROM messages_in WHERE seq % 2 = 0').get() as {
      m: number;
    };
    const seq = m + 2;

    const content = JSON.stringify({
      text: buildWakePingText(target.label),
      sender: 'system',
      senderId: 'system',
      senderName: 'System',
      isFromMe: false,
    });

    db.prepare(
      `INSERT INTO messages_in
       (id, seq, kind, timestamp, status, trigger, on_wake, channel_type, thread_id, platform_id, content)
       VALUES (?, ?, 'chat', ?, 'pending', 1, 1, ?, '', ?, ?)`,
    ).run(randomUUID(), seq, new Date().toISOString(), target.channelType, target.platformId, content);

    console.error(`wake-ping[${target.label}]: injected seq=${seq} into ${inbound}`);
  } finally {
    db.close();
  }
}

for (const target of TARGETS) {
  try {
    injectWake(target);
  } catch (err) {
    console.error(`wake-ping[${target.label}]: failed —`, err instanceof Error ? err.message : String(err));
  }
}
