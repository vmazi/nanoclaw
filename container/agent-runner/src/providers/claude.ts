import fs from 'fs';
import path from 'path';

import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { IMAGE_PATH_RE, readImageDims } from '../image-dims.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via mcp__nanoclaw__schedule_task.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];

// Tool allowlist for NanoClaw agent containers. MCP-tool entries are derived
// at the call site from the registered `mcpServers` map so that any server
// added via `add_mcp_server` (or wired in container.json directly) is
// reachable to the agent — without this, the SDK's allowedTools filter
// silently drops every MCP namespace not listed here.
const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
];

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * The API rejects a whole request when any image in the conversation exceeds
 * this on either axis. Because the transcript is replayed on every resume,
 * one oversized image poisons the session permanently — every later turn
 * fails until the session is cleared. Images only enter the transcript via
 * Read, so that is where it has to be caught.
 */
const MAX_IMAGE_DIMENSION = 2000;

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }

  if (toolName === 'Read') {
    const filePath = i.tool_input?.file_path;
    if (typeof filePath === 'string' && IMAGE_PATH_RE.test(filePath)) {
      const dims = readImageDims(filePath);
      if (dims && Math.max(dims.width, dims.height) > MAX_IMAGE_DIMENSION) {
        return {
          decision: 'block',
          stopReason:
            `Refusing to read ${filePath}: it is ${dims.width}x${dims.height}, over the ${MAX_IMAGE_DIMENSION}px ` +
            `limit. Reading it would poison this session — every later turn would fail until the session was cleared. ` +
            `Downscale it to ${MAX_IMAGE_DIMENSION}px or less on the long edge, write the smaller copy to a new path, ` +
            `and read that instead.`,
        } as unknown as ReturnType<HookCallback>;
      }
    }
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const { transcript_path: transcriptPath, session_id: sessionId } = preCompact;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) return {};

      // Try to get summary from sessions index
      let summary: string | undefined;
      const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          summary = index.entries?.find((e: { sessionId: string; summary?: string }) => e.sessionId === sessionId)?.summary;
        } catch {
          /* ignore */
        }
      }

      const name = summary
        ? summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
        : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

      const conversationsDir = '/workspace/agent/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });
      const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
      fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
      log(`Archived conversation to ${filename}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Sized for the
 * 1M-context models; compaction fires somewhat below this value.
 *
 * This is only ever an upper bound Claude Code will honour down to: the
 * effective window is min(this, the model's context window), so it does
 * nothing on its own unless the model is also resolved at 1M — see
 * withLongContext below.
 *
 * Note: the env override below only works if the var is explicitly forwarded
 * into the container — buildContainerArgs does not pass host env through.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '700000';

/**
 * Models that do not have a 1M context window. Everything else — including
 * models newer than the installed Claude Code — is assumed to have one.
 *
 * The deny-list direction is deliberate. Claude Code only recognises the
 * models it shipped with; anything newer falls back to a 200k default, which
 * is exactly the case we need to fix (claude-opus-5 reports max_input_tokens
 * of 1000000 to /v1/models, but Claude Code 2.1.x still assumes 200k for it).
 * An allow-list would silently go stale on every model release.
 */
const NO_LONG_CONTEXT_RE = /claude-3|claude-opus-4-[015]|claude-haiku/i;

/**
 * Claude Code caps the auto-compact window at the model's context window, and
 * decides that window from a built-in table rather than the model's advertised
 * capabilities. The `[1m]` suffix is its documented way of being told to use
 * the 1M window: it both raises that cap and adds the `context-1m-2025-08-07`
 * beta to the request. Claude Code appends it to its *own* default model for
 * first-party auth, but a pinned model string bypasses that entirely — so
 * without this, every group with an explicit model compacts at 200k.
 */
export function withLongContext(model: string | undefined): string | undefined {
  if (!model || /\[1m\]$/i.test(model) || NO_LONG_CONTEXT_RE.test(model)) return model;
  return `${model}[1m]`;
}

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

/**
 * Errors that mean the resumed transcript itself is unusable rather than the
 * request being at fault. Retrying is pointless — the offending content is
 * replayed on every resume — so the continuation has to be dropped for the
 * next turn to have any chance. The oversized-image case is the one we've
 * actually hit; it wedged a session for an hour because nothing cleared it.
 */
const POISONED_TRANSCRIPT_RE = /exceeds the dimension limit|start a new session/i;

/**
 * Turn a `task_notification` into something worth showing a human.
 *
 * `summary` is usually a short phrase written for exactly this — "Re-bake and
 * rebuild guide", "Find near-duplicate syncro art". But it sometimes falls
 * back to the raw command instead ("timeout 1800 python3 bake.py 2>&1 | tail
 * -3", or a `cat <<EOF` heredoc spanning lines). Forwarded as-is those render
 * as a code snippet in chat, which is noise rather than progress — measured at
 * 12 of 83 on a real session.
 *
 * Prose is passed through untouched; anything that reads like a shell command
 * is replaced with a plain status line.
 */
export function describeTask(summary?: string, status?: string): string {
  const s = (summary ?? '').trim();
  const looksLikeCommand =
    !s ||
    s.includes('\n') ||
    /^(cd|ls|cat|rm|mv|cp|grep|sed|awk|git|bash|sh|for|while|if|curl|wget|make|npm|npx|bun|node|python3?|timeout|echo|find|chmod|podman|docker|\.\/)\b/.test(
      s,
    ) ||
    /(&&|\|\||[|><]|\$\(|`)/.test(s);
  if (!looksLikeCommand) return s;
  return status === 'failed' ? 'background task failed' : 'still working';
}

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private model?: string;
  private effort?: string;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.model = withLongContext(options.model);
    this.effort = options.effort;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    };
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg) || POISONED_TRANSCRIPT_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions } : undefined,
        allowedTools: [
          ...TOOL_ALLOWLIST,
          ...Object.keys(this.mcpServers).map(mcpAllowPattern),
        ],
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        model: this.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effort: this.effort as any,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: this.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      // Collect text from intermediate assistant turns (those that also contain tool uses).
      // The SDK only puts the *final* assistant turn's text in the result event, so any
      // <message> blocks written before the first tool call would be silently dropped
      // without this accumulation.
      const intermediateTexts: string[] = [];

      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        if (message.type === 'assistant') {
          // Capture text from intermediate turns — those that include tool uses.
          // Final-turn text (no tool use) will come through in the result event.
          type ContentBlock = { type: string; text?: string };
          const content = ((message as { message?: { content?: ContentBlock[] } }).message?.content) ?? [];
          const hasToolUse = content.some((b) => b.type === 'tool_use');
          if (hasToolUse) {
            const text = content
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text)
              .join('');
            if (text) intermediateTexts.push(text);
          }
        } else if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'result') {
          const res = message as { result?: string; is_error?: boolean; subtype?: string };
          const finalText = 'result' in message ? res.result ?? null : null;
          // An error result is not assistant text. Left as a normal result it
          // gets parsed for <message> blocks, finds none, and is logged as
          // scratchpad — so the turn fails completely silently and the user
          // sees nothing at all. Throw instead: the poll loop reports it to
          // the room and drops the continuation if the session is unusable.
          if (res.is_error || (res.subtype && res.subtype !== 'success')) {
            throw new Error(
              `Claude Code returned an error result: ${finalText ?? res.subtype ?? 'unknown error'}`,
            );
          }
          const parts = [...intermediateTexts, ...(finalText ? [finalText] : [])];
          const text = parts.length > 0 ? parts.join('\n') : null;
          yield { type: 'result', text };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'rate_limit_event') {
          yield { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          yield { type: 'result', text: `Context compacted${detail}.` };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { summary?: string; status?: string };
          yield { type: 'progress', message: describeTask(tn.summary, tn.status) };
        }
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
