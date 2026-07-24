/**
 * Minimal RFC 6455 WebSocket client — zero dependencies.
 *
 * The Stoat adapter runs on whatever Node the host ships. Global `WebSocket`
 * only became unflagged in Node ~22.4, and the host build predates that, so
 * relying on it threw `WebSocket is not defined` at connect time. This hand-
 * rolled client uses only `node:tls`/`node:net`/`node:crypto`, so it works on
 * any Node ≥18 without adding an npm dependency (keeping the git-pull + tsc
 * deploy intact — nothing to `pnpm install`).
 *
 * Implements just the surface the adapter uses: `new MiniWebSocket(url)`,
 * `readyState`/`OPEN`, `send(text)`, `close()`, and the `onopen`/`onmessage`/
 * `onerror`/`onclose` handler callbacks. Client frames are masked per spec;
 * inbound text (incl. fragmented) is reassembled, pings are auto-ponged.
 */
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export class MiniWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = MiniWebSocket.CONNECTING;
  readonly OPEN = MiniWebSocket.OPEN;
  readonly CLOSING = MiniWebSocket.CLOSING;
  readonly CLOSED = MiniWebSocket.CLOSED;

  readyState = MiniWebSocket.CONNECTING;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((err?: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  private socket: Socket | null = null;
  private handshakeDone = false;
  private recvBuf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private closeEmitted = false;

  constructor(url: string) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      queueMicrotask(() => this.fail(err));
      return;
    }

    const secure = parsed.protocol === 'wss:';
    const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80;
    const host = parsed.hostname;
    const path = `${parsed.pathname || '/'}${parsed.search}`;
    const key = randomBytes(16).toString('base64');

    const onConnect = (): void => {
      const req =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`;
      this.socket?.write(req);
    };

    this.socket = secure
      ? tlsConnect({ host, port, servername: host }, onConnect)
      : netConnect({ host, port }, onConnect);

    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    this.socket.on('error', (err) => this.fail(err));
    this.socket.on('close', () => this.emitClose());
  }

  send(data: string): void {
    if (this.readyState !== MiniWebSocket.OPEN || !this.socket) return;
    this.socket.write(this.encodeFrame(OP_TEXT, Buffer.from(data, 'utf8')));
  }

  close(): void {
    if (this.readyState === MiniWebSocket.CLOSED || this.readyState === MiniWebSocket.CLOSING) return;
    this.readyState = MiniWebSocket.CLOSING;
    try {
      if (this.handshakeDone && this.socket) {
        this.socket.write(this.encodeFrame(OP_CLOSE, Buffer.alloc(0)));
      }
      this.socket?.end();
    } catch {
      /* best-effort */
    }
  }

  private fail(err?: unknown): void {
    try {
      this.onerror?.(err);
    } catch {
      /* ignore handler throw */
    }
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.emitClose();
  }

  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.readyState = MiniWebSocket.CLOSED;
    try {
      this.onclose?.();
    } catch {
      /* ignore handler throw */
    }
  }

  private onData(chunk: Buffer): void {
    this.recvBuf = this.recvBuf.length ? Buffer.concat([this.recvBuf, chunk]) : chunk;

    if (!this.handshakeDone) {
      const marker = this.recvBuf.indexOf('\r\n\r\n');
      if (marker === -1) return; // headers not complete yet
      const header = this.recvBuf.subarray(0, marker).toString('utf8');
      this.recvBuf = this.recvBuf.subarray(marker + 4);

      const statusLine = header.split('\r\n', 1)[0] ?? '';
      if (!/ 101 /.test(statusLine)) {
        this.fail(new Error(`WebSocket handshake failed: ${statusLine}`));
        return;
      }
      this.handshakeDone = true;
      this.readyState = MiniWebSocket.OPEN;
      try {
        this.onopen?.();
      } catch {
        /* ignore handler throw */
      }
    }

    this.processFrames();
  }

  private processFrames(): void {
    for (;;) {
      const buf = this.recvBuf;
      if (buf.length < 2) return;

      const b0 = buf[0]!;
      const b1 = buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const high = buf.readUInt32BE(offset);
        const low = buf.readUInt32BE(offset + 4);
        len = high * 2 ** 32 + low;
        offset += 8;
      }

      let maskKey: Buffer | null = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buf.length < offset + len) return;

      let payload = buf.subarray(offset, offset + len);
      if (maskKey) {
        const copy = Buffer.from(payload);
        for (let i = 0; i < len; i++) copy[i]! ^= maskKey[i % 4]!;
        payload = copy;
      }
      this.recvBuf = buf.subarray(offset + len);
      this.handleFrame(fin, opcode, payload);
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case OP_CONTINUATION:
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          const op = this.fragmentOpcode;
          this.fragments = [];
          this.fragmentOpcode = 0;
          this.emitData(op, full);
        }
        return;
      case OP_TEXT:
      case OP_BINARY:
        if (!fin) {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
          return;
        }
        this.emitData(opcode, payload);
        return;
      case OP_PING:
        if (this.socket && this.readyState === MiniWebSocket.OPEN) {
          this.socket.write(this.encodeFrame(OP_PONG, payload));
        }
        return;
      case OP_PONG:
        return;
      case OP_CLOSE:
        this.close();
        this.emitClose();
        return;
      default:
        return;
    }
  }

  private emitData(opcode: number, payload: Buffer): void {
    if (opcode !== OP_TEXT) return; // adapter only consumes text frames
    try {
      this.onmessage?.({ data: payload.toString('utf8') });
    } catch {
      /* ignore handler throw */
    }
  }

  private encodeFrame(opcode: number, payload: Buffer): Buffer {
    const len = payload.length;
    const mask = randomBytes(4);
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
    return Buffer.concat([header, mask, masked]);
  }
}
