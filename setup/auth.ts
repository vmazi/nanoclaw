/**
 * Step: auth — Verify or register an Anthropic credential in OneCLI.
 *
 * Modes:
 *   --check                   (default) Verify an Anthropic secret exists.
 *   --create --value <token>  Create an Anthropic secret. Errors if one
 *                             already exists unless --force is passed.
 *
 * The actual user-facing prompt (subscription vs API key, paste the token)
 * stays in the /new-setup SKILL.md. This step is just the machine side:
 * it calls `onecli secrets list` / `onecli secrets create` and emits a
 * structured status block. The token value is never logged.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

interface Args {
  mode: 'check' | 'create';
  value?: string;
  force: boolean;
}

function childEnv(): NodeJS.ProcessEnv {
  const parts = [LOCAL_BIN];
  if (process.env.PATH) parts.push(process.env.PATH);
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

function parseArgs(args: string[]): Args {
  let mode: 'check' | 'create' = 'check';
  let value: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    switch (key) {
      case '--check':
        mode = 'check';
        break;
      case '--create':
        mode = 'create';
        break;
      case '--value':
        value = val;
        i++;
        break;
      case '--force':
        force = true;
        break;
    }
  }

  if (mode === 'create' && !value) {
    emitStatus('AUTH', {
      STATUS: 'failed',
      ERROR: 'missing_value_for_create',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  return { mode, value, force };
}

interface OnecliSecret {
  id: string;
  name: string;
  type: string;
  hostPattern: string | null;
}

const ANTHROPIC_HOST = 'api.anthropic.com';

/**
 * Detect Anthropic OAuth tokens (subscription / Claude Code login). Real API
 * keys are `sk-ant-api03-...`; OAuth bearers are `sk-ant-oat01-...`. The two
 * cannot be injected the same way: the API-key route uses the `x-api-key`
 * header, the OAuth route uses `Authorization: Bearer ...`.
 */
function isOAuthToken(value: string): boolean {
  return value.startsWith('sk-ant-oat01-');
}

function listSecrets(): OnecliSecret[] {
  const out = execFileSync('onecli', ['secrets', 'list'], {
    encoding: 'utf-8',
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(out) as { data?: unknown };
  return Array.isArray(parsed.data) ? (parsed.data as OnecliSecret[]) : [];
}

/**
 * Find any secret that matches the Anthropic host. Used to be type-specific
 * (`type === 'anthropic'`), but OAuth is stored as `generic` so we match on
 * host pattern instead. Either flavor satisfies "auth is configured."
 */
function findAnthropicSecret(secrets: OnecliSecret[]): OnecliSecret | undefined {
  return secrets.find((s) => s.hostPattern === ANTHROPIC_HOST);
}

/**
 * Idempotently set a key=value line in .env. Replaces an existing line for
 * the same key, otherwise appends. Used to persist setup decisions (like
 * the Anthropic auth flavor) so the running host can read them at spawn
 * time. Not for secret values — the credential goes to OneCLI, not .env.
 */
function writeEnvKey(key: string, value: string): void {
  const envPath = path.join(process.cwd(), '.env');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    /* missing — will be created */
  }
  const lines = content.split('\n');
  const prefix = `${key}=`;
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(prefix)) {
      lines[i] = `${prefix}${value}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`${prefix}${value}`);
  }
  fs.writeFileSync(envPath, lines.join('\n'));
}

function createAnthropicSecret(value: string): void {
  // `value` is a credential — do not log it, do not echo, do not pass through a shell.
  const baseArgs = [
    'secrets',
    'create',
    '--name',
    'Anthropic',
    '--value',
    value,
    '--host-pattern',
    ANTHROPIC_HOST,
  ];
  const typeArgs = isOAuthToken(value)
    ? [
        // Generic + Authorization header → matches the SDK's
        // `Authorization: Bearer placeholder` (driven by
        // CLAUDE_CODE_OAUTH_TOKEN, which OneCLI sets in the container env).
        '--type',
        'generic',
        '--header-name',
        'Authorization',
        '--value-format',
        'Bearer {value}',
      ]
    : ['--type', 'anthropic'];
  execFileSync('onecli', [...baseArgs, ...typeArgs], {
    env: childEnv(),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

export async function run(args: string[]): Promise<void> {
  const { mode, value, force } = parseArgs(args);

  let secrets: OnecliSecret[];
  try {
    secrets = listSecrets();
  } catch (err) {
    log.error('onecli secrets list failed', { err });
    emitStatus('AUTH', {
      STATUS: 'failed',
      ERROR: 'onecli_list_failed',
      HINT: 'Is OneCLI running? Run `/new-setup` from the onecli step.',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const existing = findAnthropicSecret(secrets);

  if (mode === 'check') {
    emitStatus('AUTH', {
      SECRET_PRESENT: !!existing,
      ANTHROPIC_OK: !!existing,
      STATUS: existing ? 'success' : 'missing',
      ...(existing ? { SECRET_NAME: existing.name, SECRET_ID: existing.id } : {}),
      LOG: 'logs/setup.log',
    });
    return;
  }

  // mode === 'create'
  if (existing && !force) {
    emitStatus('AUTH', {
      SECRET_PRESENT: true,
      STATUS: 'skipped',
      REASON: 'anthropic_secret_already_exists',
      SECRET_NAME: existing.name,
      SECRET_ID: existing.id,
      HINT: 'Re-run with --force to replace, or delete the existing secret first.',
      LOG: 'logs/setup.log',
    });
    return;
  }

  try {
    createAnthropicSecret(value!);
    // Persist the auth flavor so the host can adjust container env at spawn
    // time. OneCLI sets ANTHROPIC_API_KEY=placeholder in container env
    // unconditionally; for an OAuth secret the container needs
    // CLAUDE_CODE_OAUTH_TOKEN=placeholder instead so the SDK sends an
    // Authorization: Bearer header (which OneCLI then rewrites with the
    // real OAuth token). Marker is read by src/container-runner.ts.
    if (isOAuthToken(value!)) {
      writeEnvKey('NANOCLAW_ANTHROPIC_AUTH_METHOD', 'oauth');
    } else {
      writeEnvKey('NANOCLAW_ANTHROPIC_AUTH_METHOD', 'api-key');
    }
  } catch (err) {
    const e = err as { stderr?: string | Buffer; status?: number };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8') ?? '';
    log.error('onecli secrets create failed', { status: e.status, stderr });
    emitStatus('AUTH', {
      STATUS: 'failed',
      ERROR: 'onecli_create_failed',
      EXIT_CODE: e.status ?? -1,
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // Re-verify
  const updated = findAnthropicSecret(listSecrets());

  emitStatus('AUTH', {
    SECRET_PRESENT: !!updated,
    ANTHROPIC_OK: !!updated,
    CREATED: true,
    STATUS: updated ? 'success' : 'failed',
    ...(updated ? { SECRET_NAME: updated.name, SECRET_ID: updated.id } : {}),
    LOG: 'logs/setup.log',
  });
}
