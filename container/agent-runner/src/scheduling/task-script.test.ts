import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript } from './task-script.js';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').trim() === '') {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('runScript', () => {
  it('returns the parsed result of a well-behaved script', async () => {
    const result = await runScript(
      'echo \'{"wakeAgent": true, "data": {"badges": 3}}\'',
      'ok-task',
    );
    expect(result).toEqual({ wakeAgent: true, data: { badges: 3 } });
  });

  it('returns null when wakeAgent is missing', async () => {
    const result = await runScript('echo \'{"data": 1}\'', 'no-wake-task');
    expect(result).toBeNull();
  });

  it('kills grandchild processes with the group instead of orphaning them', async () => {
    // Regression test for the zombie-leak bug: a script spawns a long-lived
    // grandchild, then trips a kill (here via the maxBuffer guard, which fires the
    // same process-group SIGKILL the timeout does). The grandchild must die with the
    // group — under the old execFile impl it would be orphaned to PID 1 and leak.
    const pidFile = path.join(os.tmpdir(), 'task-script-grandchild-pid.txt');
    try {
      fs.rmSync(pidFile, { force: true });
    } catch {
      /* ignore */
    }

    const script = [
      // Background grandchild that outlives bash; record its pid.
      `sleep 30 & echo $! > ${pidFile}`,
      // Flood stdout past SCRIPT_MAX_BUFFER (1MB) to trip the group kill.
      `yes X | head -c 2000000`,
    ].join('\n');

    const runPromise = runScript(script, 'group-kill-task');
    await waitForFile(pidFile);
    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(grandchildPid).toBeGreaterThan(0);

    const result = await runPromise;
    expect(result).toBeNull();

    // Give the SIGKILL a moment to land across the group.
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(grandchildPid)).toBe(false);

    try {
      fs.rmSync(pidFile, { force: true });
    } catch {
      /* ignore */
    }
  });
});
