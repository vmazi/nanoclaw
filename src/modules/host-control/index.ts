/**
 * Host control module — agent-triggered host restart via systemd.
 *
 * Registers the `restart_host` delivery action. When Cortex emits a
 * `restart_host` system message via its MCP tool, this handler just exits
 * the host process cleanly. Systemd's `Restart=always` policy on the
 * `nanoclaw-v2-*.service` unit notices the exit and re-runs the whole
 * `ExecStartPre` chain (git fetch + merge, build if stale, wake-ping)
 * before bringing the host back up. Cortex's container is killed as part
 * of the host's graceful shutdown and respawned on the next message.
 *
 * No flag file, no shell wrapper, no SIGTERM dance — systemd owns the
 * restart loop. If the host is run outside systemd (e.g. `node dist/...`
 * directly during dev), `restart_host` will just stop the host without
 * restarting it.
 *
 * No approval flow: trust boundary is the messaging-group ACL. If a user
 * can reach the agent and the agent calls this tool, the restart is
 * authorized.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';

registerDeliveryAction('restart_host', async (content, session) => {
  const reason = (content.reason as string) || '(no reason given)';
  log.info('restart_host requested — exiting for systemd to restart', {
    sessionId: session.id,
    reason,
  });
  setTimeout(() => process.exit(0), 100);
});
