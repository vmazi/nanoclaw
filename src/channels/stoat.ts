/**
 * Stoat (Revolt) channel adapter — native, dependency-free.
 *
 * Connects to the Bonfire events websocket with a bot token (passed as a URL
 * query param, matching the upstream stoat.js EventClient) and delivers replies
 * via the REST API. Relies on Node 22 global `WebSocket` + `fetch`, so it adds
 * no npm dependency — a plain `git merge` + `tsc` build on the host is enough to
 * ship it, with nothing to `pnpm install`.
 *
 * platform_id === Stoat channel id. channelType is always "stoat"; the router
 * combines channelType + platformId to resolve the messaging_group.
 */
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

interface StoatConfig {
  apiUrl: string; // e.g. https://sig.borgorg.org/api
  botToken: string;
}

interface RevoltConfig {
  ws: string;
  app?: string;
  features?: { autumn?: { url?: string } };
}

interface BonfireEvent {
  type: string;
  data?: number;
  [k: string]: unknown;
}

interface StoatMessageEvent {
  _id: string;
  channel: string;
  author: string;
  content?: string | null;
  mentions?: string[];
  attachments?: Array<{ _id: string; filename?: string }>;
  system?: unknown;
  webhook?: unknown;
}

interface ChannelInfo {
  type: string;
  name?: string;
  server?: string;
}

const HEARTBEAT_MS = 20_000;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 20_000];
const MAX_CONTENT = 2000; // Revolt content length cap

export function createStoatAdapter(config: StoatConfig): ChannelAdapter {
  let setup: ChannelSetup | null = null;
  let ws: WebSocket | null = null;
  let connected = false;
  let closed = false;
  let botId: string | null = null;
  let wsUrl: string | null = null;
  let autumnUrl: string | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempt = 0;

  const channelCache = new Map<string, ChannelInfo>();
  const userNameCache = new Map<string, string>();

  async function apiGet<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${config.apiUrl}${path}`, {
        headers: { 'X-Bot-Token': config.botToken },
      });
      if (!res.ok) {
        log.warn('Stoat: GET failed', { path, status: res.status });
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      log.warn('Stoat: GET error', { path, err });
      return null;
    }
  }

  async function getChannelInfo(id: string): Promise<ChannelInfo> {
    const cached = channelCache.get(id);
    if (cached) return cached;
    const raw = await apiGet<{ channel_type?: string; name?: string; server?: string }>(`/channels/${id}`);
    const info: ChannelInfo = { type: raw?.channel_type ?? 'Unknown', name: raw?.name, server: raw?.server };
    channelCache.set(id, info);
    return info;
  }

  async function getUserName(id: string): Promise<string> {
    const cached = userNameCache.get(id);
    if (cached) return cached;
    const raw = await apiGet<{ username?: string; display_name?: string }>(`/users/${id}`);
    const name = raw?.display_name || raw?.username || id;
    userNameCache.set(id, name);
    return name;
  }

  // -- inbound --

  async function handleMessage(m: StoatMessageEvent): Promise<void> {
    if (!setup) return;
    if (!m.author || (botId && m.author === botId)) return; // never echo our own messages
    if (m.system || m.webhook) return;

    let text = (m.content ?? '').trim();
    const attachments = m.attachments ?? [];
    if (!text && attachments.length === 0) return;

    const info = await getChannelInfo(m.channel);
    const isDM = info.type === 'DirectMessage' || info.type === 'SavedMessages';
    const isGroup = !isDM;
    // In a DM every message is for us; in a server/group channel, only when the
    // bot is explicitly mentioned. The router falls back to name-matching when
    // isMention is undefined, but Stoat gives us an exact mentions list.
    const isMention = isDM || (Array.isArray(m.mentions) && !!botId && m.mentions.includes(botId));

    if (attachments.length > 0 && autumnUrl) {
      for (const a of attachments) {
        const fn = a.filename ?? a._id;
        const url = `${autumnUrl}/attachments/${a._id}/${encodeURIComponent(fn)}`;
        const line = `[Attachment: ${fn}] ${url}`;
        text = text ? `${text}\n${line}` : line;
      }
    }

    const senderName = await getUserName(m.author);
    const chatName = info.name ?? (isDM ? senderName : undefined);
    setup.onMetadata(m.channel, chatName, isGroup);

    const msg: InboundMessage = {
      id: m._id,
      kind: 'chat',
      content: {
        text,
        sender: m.author,
        senderId: `stoat:${m.author}`,
        senderName,
      },
      timestamp: new Date().toISOString(),
      isMention,
      isGroup,
    };
    await setup.onInbound(m.channel, null, msg);
    log.info('Stoat message received', { channel: m.channel, sender: senderName });
  }

  async function handleEvent(evt: BonfireEvent): Promise<void> {
    switch (evt.type) {
      case 'Authenticated':
        log.info('Stoat: authenticated');
        return;
      case 'Ready':
        connected = true;
        reconnectAttempt = 0;
        log.info('Stoat channel ready', { botId });
        return;
      case 'Ping':
        // Server heartbeat — echo back a Pong so it doesn't drop us.
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'Pong', data: evt.data ?? Date.now() }));
        }
        return;
      case 'Pong':
        return;
      case 'Error':
        log.error('Stoat: server error event', { data: evt.data });
        return;
      case 'Message':
        await handleMessage(evt as unknown as StoatMessageEvent);
        return;
      default:
        return;
    }
  }

  // -- websocket lifecycle --

  function stopHeartbeat(): void {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function connect(): void {
    if (closed || !wsUrl) return;
    const url = `${wsUrl}?version=1&format=json&token=${encodeURIComponent(config.botToken)}`;
    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = (): void => {
      log.info('Stoat: ws open');
      stopHeartbeat();
      heartbeat = setInterval(() => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'Ping', data: Date.now() }));
        }
      }, HEARTBEAT_MS);
    };

    socket.onmessage = (event): void => {
      if (typeof event.data !== 'string') return;
      let evt: BonfireEvent;
      try {
        evt = JSON.parse(event.data) as BonfireEvent;
      } catch {
        return; // ignore non-JSON frames
      }
      handleEvent(evt).catch((err) => log.error('Stoat: event handler error', { err }));
    };

    socket.onerror = (): void => {
      // A close event follows and drives reconnection; just note it.
      log.warn('Stoat: ws error');
    };

    socket.onclose = (): void => {
      connected = false;
      stopHeartbeat();
      if (ws === socket) ws = null;
      if (closed) return;
      const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
      reconnectAttempt += 1;
      log.warn('Stoat: disconnected, reconnecting', { delayMs: delay, attempt: reconnectAttempt });
      setTimeout(() => {
        if (!closed) connect();
      }, delay);
    };
  }

  // -- outbound --

  function chunk(text: string): string[] {
    if (text.length <= MAX_CONTENT) return [text];
    const parts: string[] = [];
    let rest = text;
    while (rest.length > MAX_CONTENT) {
      let cut = rest.lastIndexOf('\n', MAX_CONTENT);
      if (cut < MAX_CONTENT * 0.5) cut = MAX_CONTENT;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest) parts.push(rest);
    return parts;
  }

  function extractText(message: OutboundMessage): string | null {
    const content = message.content as Record<string, unknown> | string | undefined;
    if (typeof content === 'string') return content;
    if (content && typeof content === 'object') {
      if (typeof content.text === 'string') return content.text;
      if (typeof content.fallbackText === 'string') return content.fallbackText;
    }
    return null;
  }

  async function sendMessage(channelId: string, content: string): Promise<string | undefined> {
    try {
      const res = await fetch(`${config.apiUrl}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'X-Bot-Token': config.botToken,
          'Content-Type': 'application/json',
          'Idempotency-Key': `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log.error('Stoat: send failed', { channelId, status: res.status, body });
        return undefined;
      }
      const json = (await res.json()) as { _id?: string };
      return json._id;
    } catch (err) {
      log.error('Stoat: send error', { channelId, err });
      return undefined;
    }
  }

  const adapter: ChannelAdapter = {
    name: 'stoat',
    channelType: 'stoat',
    supportsThreads: false,

    async setup(cfg: ChannelSetup): Promise<void> {
      setup = cfg;
      closed = false;

      const me = await apiGet<{ _id: string; username?: string }>('/users/@me');
      if (!me?._id) {
        const err = new Error('Stoat: failed to fetch bot identity (bad token or API unreachable)');
        (err as { name: string }).name = 'NetworkError';
        throw err;
      }
      botId = me._id;

      const rc = await apiGet<RevoltConfig>('/');
      wsUrl = rc?.ws ?? null;
      autumnUrl = rc?.features?.autumn?.url ?? null;
      if (!wsUrl) {
        const err = new Error('Stoat: server config missing ws URL');
        (err as { name: string }).name = 'NetworkError';
        throw err;
      }

      log.info('Stoat: connecting', { botId, username: me.username, wsUrl });
      connect();
    },

    async teardown(): Promise<void> {
      closed = true;
      stopHeartbeat();
      try {
        ws?.close();
      } catch {
        /* best-effort */
      }
      ws = null;
      connected = false;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const text = extractText(message);
      const files = message.files ?? [];
      let firstId: string | undefined;

      if (text) {
        for (const part of chunk(text)) {
          const id = await sendMessage(platformId, part);
          if (!firstId) firstId = id;
        }
      }

      if (files.length > 0) {
        // File upload (autumn) is not wired yet — surface the names so nothing
        // is silently dropped.
        log.warn('Stoat: outbound files not yet supported', { platformId, files: files.map((f) => f.filename) });
        await sendMessage(platformId, `[Attachments not delivered: ${files.map((f) => f.filename).join(', ')}]`);
      }

      return firstId;
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerChannelAdapter('stoat', {
  factory: () => {
    const envVars = readEnvFile(['STOAT_BOT_TOKEN', 'STOAT_API_URL']);
    const botToken = process.env.STOAT_BOT_TOKEN || envVars.STOAT_BOT_TOKEN || '';
    if (!botToken) {
      log.debug('Stoat: STOAT_BOT_TOKEN not set, skipping channel');
      return null;
    }
    const apiUrl = (process.env.STOAT_API_URL || envVars.STOAT_API_URL || 'https://sig.borgorg.org/api').replace(
      /\/$/,
      '',
    );
    return createStoatAdapter({ apiUrl, botToken });
  },
});
