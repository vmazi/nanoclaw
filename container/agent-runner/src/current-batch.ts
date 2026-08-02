/**
 * Per-batch context the poll loop publishes for downstream consumers
 * (MCP tools, etc.) that don't sit on the poll-loop's call stack.
 *
 * - `inReplyTo` — the id of the first inbound message in the batch the agent
 *   is currently processing. MCP tools like `send_message` and `send_file`
 *   read this and stamp it onto the outbound row so the host's a2a
 *   return-path routing can correlate replies back to the originating session.
 * - `lastAddressed` — the destination the agent most recently addressed via
 *   `send_message` this batch. Progress pings follow it so a "still working"
 *   update lands in the conversation the agent is actually talking in, not
 *   whichever room happened to trigger a shared session (see `sendProgress`).
 *
 * This is module-level state on purpose: the agent-runner is single-process
 * and processes one batch at a time. Poll-loop calls `setCurrentInReplyTo`
 * before invoking the provider and `clearCurrentInReplyTo` after the batch
 * completes (or errors out); both fields are reset together per batch.
 */
let currentInReplyTo: string | null = null;

/** Resolved routing of the agent's most recent `send_message` this batch. */
export interface AddressedDestination {
  platformId: string;
  channelType: string;
  threadId: string | null;
}

let lastAddressed: AddressedDestination | null = null;

export function setCurrentInReplyTo(id: string | null): void {
  currentInReplyTo = id;
}

export function clearCurrentInReplyTo(): void {
  currentInReplyTo = null;
  lastAddressed = null;
}

export function getCurrentInReplyTo(): string | null {
  return currentInReplyTo;
}

export function setLastAddressed(dest: AddressedDestination | null): void {
  lastAddressed = dest;
}

export function getLastAddressed(): AddressedDestination | null {
  return lastAddressed;
}

