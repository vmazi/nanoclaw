/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/**
 * CLI args needed for the container to reach host services (notably the
 * OneCLI gateway, which binds to 127.0.0.1).
 *
 * Three platforms behave differently:
 *
 *   macOS Docker Desktop / Apple Container — `host.docker.internal` is
 *     built into the runtime's VM bridge and routes to host loopback.
 *     No flags needed.
 *
 *   Linux + Docker (rootful) — `--add-host=host.docker.internal:host-gateway`
 *     resolves to the docker bridge gateway, which can reach host services
 *     on any interface (including 127.0.0.1 via DNAT).
 *
 *   Linux + rootless podman — the `host-gateway` literal *does* resolve,
 *     but it routes via the host's external interface and cannot reach
 *     services bound to host loopback. Rootless podman provides
 *     `slirp4netns:allow_host_loopback=true` which exposes host loopback
 *     at the special address 10.0.2.2; we map host.docker.internal there.
 *     Without this, the agent container hits ConnectionRefused trying to
 *     talk to OneCLI on 127.0.0.1:10255.
 */
export function hostGatewayArgs(): string[] {
  if (os.platform() !== 'linux') return [];
  if (isPodman()) {
    return ['--network=slirp4netns:allow_host_loopback=true', '--add-host=host.docker.internal:10.0.2.2'];
  }
  return ['--add-host=host.docker.internal:host-gateway'];
}

let cachedIsPodman: boolean | undefined;

/**
 * True if `docker` on this host is actually podman (common on Fedora/RHEL,
 * where users symlink `docker -> /usr/bin/podman`). Cached after first probe.
 *
 * We probe `docker info --format '{{.Host.BuildahVersion}}'` rather than
 * `docker --version` because podman 5.x masquerades as docker in its version
 * string (literally prints "docker version 5.8.2"). The `Host.BuildahVersion`
 * field is podman-specific — real Docker either errors on the template or
 * returns empty.
 */
export function isPodman(): boolean {
  if (cachedIsPodman !== undefined) return cachedIsPodman;
  try {
    const out = execSync(`${CONTAINER_RUNTIME_BIN} info --format '{{.Host.BuildahVersion}}'`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 5000,
    });
    cachedIsPodman = out.trim().length > 0;
  } catch {
    cachedIsPodman = false;
  }
  return cachedIsPodman;
}

/**
 * CLI args for user-namespace mapping.
 *
 * Rootless podman remaps host UIDs into the container's user namespace by
 * default: a host file owned by the host user appears as uid 0 inside the
 * container, while the container process runs as a non-root user (`node`,
 * uid 1000 in our image). With mode 0644 session DBs the container can read
 * but not write — SQLite then fails with "attempt to write a readonly
 * database". `--userns=keep-id` makes the host user's uid match inside the
 * container so writes work. Docker (rootful or Desktop) uses host UIDs
 * directly and doesn't accept this flag, so it stays podman-only.
 */
export function userNamespaceArgs(): string[] {
  if (os.platform() === 'linux' && isPodman()) {
    return ['--userns=keep-id'];
  }
  return [];
}

/**
 * Build the option suffix for a bind mount (e.g. ":ro,z").
 *
 * On Linux we always append `z` so podman/docker relabel the host directory
 * for SELinux. The flag is a no-op on Docker daemons without SELinux support
 * and on non-Linux platforms, so we only emit it on Linux.
 *
 * Socket files are excluded from `:z` relabeling — the relabel changes the
 * SELinux type to container_file_t which blocks container_t from connecting.
 * Sockets should be pre-labeled with container_runtime_t on the host instead.
 */
function mountOptionSuffix(readonly: boolean, skipSelinuxLabel = false): string {
  const opts: string[] = [];
  if (readonly) opts.push('ro');
  if (os.platform() === 'linux' && !skipSelinuxLabel) opts.push('z');
  return opts.length > 0 ? `:${opts.join(',')}` : '';
}

function isSocketFile(hostPath: string): boolean {
  try {
    return fs.statSync(hostPath).isSocket();
  } catch {
    return false;
  }
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}${mountOptionSuffix(true, isSocketFile(hostPath))}`];
}

/** Returns CLI args for a writable bind mount. */
export function writableMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}${mountOptionSuffix(false, isSocketFile(hostPath))}`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/**
 * True if the image tag exists in local image storage. Does NOT consult any
 * registry — purely a local lookup. Both docker and podman accept
 * `image inspect <tag>`; exit 0 if present, non-zero if not.
 */
export function imageExists(tag: string): boolean {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-:/]*$/.test(tag)) {
    throw new Error(`Invalid image tag: ${tag}`);
  }
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} image inspect ${tag} --format '{{.Id}}'`, {
      stdio: 'pipe',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
