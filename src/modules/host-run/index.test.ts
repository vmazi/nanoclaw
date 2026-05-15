import { describe, expect, it } from 'vitest';
import { wouldKillHostProcess } from './index.js';

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

  it('allows benign commands that mention nanoclaw in unrelated contexts', () => {
    expect(wouldKillHostProcess('ls /var/home/vmaz/dev/nanoclaw')).toBe(false);
    expect(wouldKillHostProcess('cd nanoclaw && git pull')).toBe(false);
    expect(wouldKillHostProcess('./container/build.sh')).toBe(false);
    expect(wouldKillHostProcess('docker ps | grep nanoclaw')).toBe(false);
  });
});
