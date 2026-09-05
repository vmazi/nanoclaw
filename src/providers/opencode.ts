/**
 * opencode provider container config.
 *
 * Two things the container can't supply for itself:
 *
 *  - opencode keeps its session store under XDG_DATA_HOME. Containers are
 *    spawned with --rm, so without a host mount the store is discarded every
 *    turn and the continuation id from the previous turn resolves to nothing.
 *    Mounting the per-session dir is what makes resume work at all.
 *
 *  - the agent-runner talks to `opencode serve` over 127.0.0.1. OneCLI sets
 *    HTTPS_PROXY for outbound credential injection, and undici will happily
 *    route a loopback request through it, so loopback has to be excluded.
 *
 * The endpoint credentials come from the host .env rather than container.json
 * so the API key stays out of the group's readable config.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const CONTAINER_DATA_HOME = '/home/node/.local/share';

registerProviderContainerConfig('opencode', (ctx) => {
  const dotenv = readEnvFile(['SELFSERV_BASE_URL', 'SELFSERV_API_KEY']);

  const dataDir = path.join(ctx.sessionDir, 'opencode-data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Mounting at .local/share leaves .local itself root-owned, so opencode's
  // mkdir of a sibling .local/state fails with EACCES and the server never
  // binds. Every XDG dir it touches has to land inside the one writable mount.
  const env: Record<string, string> = {
    XDG_DATA_HOME: CONTAINER_DATA_HOME,
    XDG_STATE_HOME: `${CONTAINER_DATA_HOME}/state`,
    XDG_CACHE_HOME: `${CONTAINER_DATA_HOME}/cache`,
    XDG_CONFIG_HOME: `${CONTAINER_DATA_HOME}/config`,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  if (dotenv.SELFSERV_BASE_URL) env.SELFSERV_BASE_URL = dotenv.SELFSERV_BASE_URL;
  if (dotenv.SELFSERV_API_KEY) env.SELFSERV_API_KEY = dotenv.SELFSERV_API_KEY;

  return {
    mounts: [{ hostPath: dataDir, containerPath: CONTAINER_DATA_HOME, readonly: false }],
    env,
  };
});
