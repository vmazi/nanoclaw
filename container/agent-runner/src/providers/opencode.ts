import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { logger } from '../log.js';

const log = logger('opencode-provider');

const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode';
const PORT = Number(process.env.OPENCODE_PORT || 4096);
const BASE = `http://127.0.0.1:${PORT}`;

/** Provider id registered inside opencode's own config for the self-served model. */
const PROVIDER_ID = 'selfserv';

/**
 * opencode resolves a model as `providerID/modelID`. Anything the runner is
 * given as a bare model name is assumed to live on the self-served endpoint.
 */
function splitModel(model: string | undefined): { providerID: string; id: string } {
  const fallback = { providerID: PROVIDER_ID, id: 'qwen3-coder' };
  if (!model) return fallback;
  const slash = model.indexOf('/');
  if (slash === -1) return { providerID: PROVIDER_ID, id: model };
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

/**
 * nanoclaw describes an MCP server as {command, args, env}; opencode wants the
 * command and its arguments flattened into one array under `command`.
 */
function toOpencodeMcp(servers: Record<string, McpServerConfig>) {
  const out: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    out[name] = {
      type: 'local',
      command: [cfg.command, ...cfg.args],
      environment: cfg.env,
      enabled: true,
    };
  }
  return out;
}

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function api<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`opencode ${method} ${urlPath} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** Matches opencode's 404 for a session id that no longer exists. */
const STALE_SESSION_RE = /session[^]{0,40}(not found|does not exist)|-> 404/i;

export class OpencodeProvider implements AgentProvider {
  // opencode's slash commands are its own TUI's, not ours — let the poll loop
  // format them as ordinary text.
  readonly supportsNativeSlashCommands = false;

  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private model: { providerID: string; id: string };
  private serverStarted: Promise<void> | null = null;

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers ?? {};
    this.env = options.env ?? {};
    this.model = splitModel(options.model);
  }

  isSessionInvalid(err: unknown): boolean {
    return STALE_SESSION_RE.test(err instanceof Error ? err.message : String(err));
  }

  /**
   * opencode reads config from disk at startup, so the config has to be written
   * before the server is spawned — including the MCP servers, which are how the
   * agent reaches every nanoclaw tool.
   */
  private writeConfig(cwd: string, instructions?: string): void {
    const baseURL = this.env.SELFSERV_BASE_URL;
    const apiKey = this.env.SELFSERV_API_KEY;
    if (!baseURL || !apiKey) {
      throw new Error('opencode provider requires SELFSERV_BASE_URL and SELFSERV_API_KEY in env');
    }

    const instructionFiles: string[] = [];
    if (instructions) {
      const p = path.join(cwd, '.opencode-instructions.md');
      fs.writeFileSync(p, instructions);
      instructionFiles.push(p);
    }

    const config = {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        [PROVIDER_ID]: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Self-served (Modal)',
          options: { baseURL, apiKey },
          models: { [this.model.id]: { name: this.model.id } },
        },
      },
      model: `${this.model.providerID}/${this.model.id}`,
      mcp: toOpencodeMcp(this.mcpServers),
      instructions: instructionFiles,
      // The container is already an isolation boundary; a second permission
      // prompt layer would just deadlock a headless run.
      permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' },
      autoupdate: false,
    };

    fs.writeFileSync(path.join(cwd, 'opencode.json'), JSON.stringify(config, null, 2));
  }

  private async ensureServer(cwd: string): Promise<void> {
    if (this.serverStarted) return this.serverStarted;

    this.serverStarted = (async () => {
      const child = spawn(OPENCODE_BIN, ['serve', '--port', String(PORT), '--hostname', '127.0.0.1'], {
        cwd,
        env: { ...process.env, ...this.env } as NodeJS.ProcessEnv,
        stdio: 'ignore',
        detached: false,
      });
      child.on('exit', (code) => log(`opencode serve exited: ${code}`));

      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${BASE}/doc`);
          if (res.ok) {
            log(`opencode serve ready on ${BASE}`);
            return;
          }
        } catch {
          /* not up yet */
        }
        await sleep(500);
      }
      throw new Error('opencode serve did not become ready within 60s');
    })();

    return this.serverStarted;
  }

  query(input: QueryInput): AgentQuery {
    const self = this;
    let aborted = false;
    let sessionID = input.continuation ?? '';
    const pending: string[] = [];

    async function* run(): AsyncGenerator<ProviderEvent> {
      self.writeConfig(input.cwd, input.systemContext?.instructions);
      await self.ensureServer(input.cwd);
      yield { type: 'activity' };

      if (!sessionID) {
        const created = await api<{ data: { id: string } }>('POST', '/api/session', {
          model: { providerID: self.model.providerID, id: self.model.id },
        });
        sessionID = created.data.id;
      }
      yield { type: 'init', continuation: sessionID };

      // Subscribe before prompting so the idle event that ends the turn cannot
      // land in the gap between the two.
      const stream = await fetch(`${BASE}/event`);
      if (!stream.ok || !stream.body) throw new Error(`opencode event stream failed: ${stream.status}`);
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();

      await api('POST', `/api/session/${sessionID}/prompt`, {
        prompt: { text: input.prompt },
        delivery: 'queue',
      });

      let buf = '';
      const texts: string[] = [];

      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';

        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let evt: Record<string, any>;
          try {
            evt = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }

          yield { type: 'activity' };

          const sync = evt.syncEvent ?? evt;
          const kind: string = sync.type ?? evt.type ?? '';
          const data = sync.data ?? evt.properties ?? {};
          if (data.sessionID && data.sessionID !== sessionID) continue;

          if (kind.startsWith('session.next.text.ended')) {
            if (typeof data.text === 'string') texts.push(data.text);
          } else if (kind.startsWith('session.next.tool.called')) {
            yield { type: 'progress', message: `running ${data.tool ?? 'tool'}` };
          } else if (kind.startsWith('session.next.step.failed')) {
            yield {
              type: 'error',
              message: `opencode step failed: ${JSON.stringify(data.error ?? {}).slice(0, 300)}`,
              retryable: false,
            };
          } else if (kind === 'session.idle') {
            yield { type: 'result', text: texts.length ? texts.join('\n') : null };
            texts.length = 0;

            if (pending.length === 0) {
              reader.cancel().catch(() => {});
              return;
            }
            await api('POST', `/api/session/${sessionID}/prompt`, {
              prompt: { text: pending.shift()! },
              delivery: 'queue',
            });
          }
        }
      }
      reader.cancel().catch(() => {});
    }

    return {
      // Mid-turn arrivals steer the running turn, matching how the poll loop
      // feeds follow-ups to Claude. Anything that lands before the session
      // exists is held and sent at the first idle.
      push(message: string) {
        if (!sessionID) {
          pending.push(message);
          return;
        }
        api('POST', `/api/session/${sessionID}/prompt`, {
          prompt: { text: message },
          delivery: 'steer',
        }).catch((e) => log(`push failed: ${e}`));
      },
      end() {
        /* the idle event ends the turn; nothing to flush */
      },
      events: run(),
      abort() {
        aborted = true;
        if (sessionID) {
          api('POST', `/api/session/${sessionID}/interrupt`, {}).catch(() => {});
        }
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpencodeProvider(opts));
