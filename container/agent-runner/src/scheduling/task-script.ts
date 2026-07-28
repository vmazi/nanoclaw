import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MessageInRow } from '../db/messages-in.js';
import { touchHeartbeat } from '../db/connection.js';

const SCRIPT_TIMEOUT_MS = 30_000;
// Grace between SIGTERM and the SIGKILL escalation when a script overruns.
const SCRIPT_KILL_GRACE_MS = 2_000;
const SCRIPT_MAX_BUFFER = 1024 * 1024;

export interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

function log(msg: string): void {
  console.error(`[task-script] ${msg}`);
}

export async function runScript(script: string, taskId: string): Promise<ScriptResult | null> {
  const scriptPath = path.join('/tmp', `task-script-${taskId}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    // Spawn detached so the script becomes its own process-group leader: on Linux
    // `detached` calls setsid(), making child.pid double as the process-group id.
    // On timeout we signal the whole group (`-child.pid`) instead of just the direct
    // bash child. execFile's timeout kills only bash, which orphans any node/subprocess
    // the script spawned to PID 1 — and PID 1 in this container is bun, which does not
    // reap orphans. Result was one <defunct> zombie per overrun until the container hit
    // pids.max. Killing the group tears the grandchildren down with bash.
    const child = spawn('bash', [scriptPath], { detached: true, env: process.env });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        // Negative pid targets the entire process group.
        process.kill(-child.pid, signal);
      } catch {
        /* group already gone (ESRCH) */
      }
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      log(`[${taskId}] timed out after ${SCRIPT_TIMEOUT_MS}ms, killing process group`);
      killGroup('SIGTERM');
      // Escalate to SIGKILL if the group ignores SIGTERM.
      killTimer = setTimeout(() => killGroup('SIGKILL'), SCRIPT_KILL_GRACE_MS);
    }, SCRIPT_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutTruncated) return;
      stdout += chunk.toString();
      if (stdout.length > SCRIPT_MAX_BUFFER) {
        stdout = stdout.slice(0, SCRIPT_MAX_BUFFER);
        stdoutTruncated = true;
        log(`[${taskId}] stdout exceeded ${SCRIPT_MAX_BUFFER} bytes, killing process group`);
        killGroup('SIGKILL');
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < SCRIPT_MAX_BUFFER) stderr += chunk.toString();
    });

    const finish = (result: ScriptResult | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* best-effort cleanup */
      }
      resolve(result);
    };

    child.on('error', (err) => {
      log(`[${taskId}] spawn error: ${err.message}`);
      finish(null);
    });

    // 'close' (not 'exit') so we wait for stdio to flush — and, crucially, for any
    // grandchild still holding the pipe open, which the timeout above will reap.
    child.on('close', (code, signal) => {
      if (stderr) {
        log(`[${taskId}] stderr: ${stderr.slice(0, 500)}`);
      }

      if (timedOut) {
        log(`[${taskId}] killed after timeout`);
        return finish(null);
      }
      if (stdoutTruncated) {
        log(`[${taskId}] output truncated at maxBuffer`);
        return finish(null);
      }
      if (code !== 0) {
        log(`[${taskId}] exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
        return finish(null);
      }

      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        log(`[${taskId}] no output`);
        return finish(null);
      }

      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') {
          log(`[${taskId}] output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
          return finish(null);
        }
        finish(result as ScriptResult);
      } catch {
        log(`[${taskId}] output is not valid JSON: ${lastLine.slice(0, 200)}`);
        finish(null);
      }
    });
  });
}

export interface TaskScriptOutcome {
  keep: MessageInRow[];
  skipped: string[];
}

/**
 * Run pre-task scripts for any task messages that carry one, serially.
 * - Errors / missing output / wakeAgent=false → task id added to `skipped`.
 * - wakeAgent=true → content JSON is mutated to carry `scriptOutput`, so the
 *   formatter renders it into the prompt.
 * Non-task messages and tasks without scripts pass through unchanged.
 */
export async function applyPreTaskScripts(messages: MessageInRow[]): Promise<TaskScriptOutcome> {
  const keep: MessageInRow[] = [];
  const skipped: string[] = [];

  for (const msg of messages) {
    if (msg.kind !== 'task') {
      keep.push(msg);
      continue;
    }

    let content: Record<string, unknown>;
    try {
      content = JSON.parse(msg.content);
    } catch {
      keep.push(msg);
      continue;
    }

    const script = typeof content.script === 'string' ? (content.script as string) : null;
    if (!script) {
      keep.push(msg);
      continue;
    }

    log(`running script for task ${msg.id}`);
    touchHeartbeat();
    const result = await runScript(script, msg.id);
    touchHeartbeat();

    if (!result || !result.wakeAgent) {
      const reason = result ? 'wakeAgent=false' : 'script error/no output';
      log(`task ${msg.id} skipped: ${reason}`);
      skipped.push(msg.id);
      continue;
    }

    log(`task ${msg.id} wakeAgent=true, enriching prompt`);
    content.scriptOutput = result.data ?? null;
    keep.push({ ...msg, content: JSON.stringify(content) });
  }

  return { keep, skipped };
}
