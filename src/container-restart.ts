/**
 * Helper to restart all running containers for an agent group.
 *
 * Writes an on_wake message to each session, kills the container, then
 * wakes a fresh container via the onExit callback — race-free.
 */
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { buildWakePingText, postStartupPingToStoat } from './modules/wake-ping/index.js';
import { writeSessionMessage } from './session-manager.js';

/**
 * Kill all running containers for an agent group and respawn them.
 *
 * Always injects a wake-ping as the on_wake message so the fresh container
 * announces itself. If `wakeMessage` is also provided, it is injected as a
 * second on_wake message delivered right after the wake-ping.
 */
export function restartAgentGroupContainers(agentGroupId: string, reason: string, wakeMessage?: string): number {
  const sessions = getSessionsByAgentGroup(agentGroupId).filter(
    (s) => s.status === 'active' && isContainerRunning(s.id),
  );

  for (const session of sessions) {
    // Always inject a wake-ping so the agent announces itself on every restart.
    writeSessionMessage(agentGroupId, session.id, {
      id: `wake-ping-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: agentGroupId,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: buildWakePingText(),
        sender: 'system',
        senderId: 'system',
      }),
      onWake: 1,
    });

    if (wakeMessage) {
      writeSessionMessage(agentGroupId, session.id, {
        id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: agentGroupId,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({
          text: wakeMessage,
          sender: 'system',
          senderId: 'system',
        }),
        onWake: 1,
      });
    }

    killContainer(session.id, reason, () => {
      const s = getSession(session.id);
      if (s) wakeContainer(s);
    });
  }

  if (sessions.length > 0) {
    log.info('Restarting agent group containers', { agentGroupId, reason, count: sessions.length });
    // Announce online in the Stoat #startup-ping channel (best-effort, fire-and-forget).
    void postStartupPingToStoat();
  }
  return sessions.length;
}
