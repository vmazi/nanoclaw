/**
 * Matrix room MCP tool — agent-driven creation of new Matrix rooms.
 *
 * `create_matrix_room` is fire-and-forget: the tool writes a system action
 * row and returns. The host's matrix delivery handler creates an encrypted
 * room, invites the given user(s), wires it to your agent group (same shared
 * brain, its own session), and optionally posts an opening message. The new
 * room becomes its own session when someone messages in it.
 *
 * Use when the user asks you to start a new Matrix chat / channel / room, or
 * when you want a fresh dedicated conversation space.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const createMatrixRoom: McpToolDefinition = {
  tool: {
    name: 'create_matrix_room',
    description:
      'Create a new encrypted Matrix room and wire it to your agent group so it becomes its own session/conversation. Invite the given Matrix user(s). Optionally set a name/topic and post an opening message immediately. Use when the user asks you to start a new Matrix chat, channel, or room. Fire-and-forget: the room is created on the host asynchronously.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        invite: {
          type: 'array',
          items: { type: 'string' },
          description: 'Matrix user IDs to invite, e.g. ["@vmaz:matrix.borgorg.org"].',
        },
        name: { type: 'string', description: 'Room name (for a named group room).' },
        topic: { type: 'string', description: 'Optional room topic/description.' },
        opening_message: {
          type: 'string',
          description: 'Optional message posted into the new room immediately after creation.',
        },
        direct: {
          type: 'boolean',
          description: 'Create as a 1:1 DM (true) instead of a named group room (default false).',
        },
      },
      required: ['invite'],
    },
  },
  async handler(args) {
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_matrix_room',
        invite: args.invite,
        name: args.name,
        topic: args.topic,
        opening_message: args.opening_message,
        direct: args.direct,
      }),
    });
    return ok(
      'Matrix room creation requested. The host will create the encrypted room, invite the user(s), wire it to your agent group, and post your opening message if provided. It becomes its own session when someone messages there.',
    );
  },
};

export const listMatrixRooms: McpToolDefinition = {
  tool: {
    name: 'list_matrix_rooms',
    description:
      'List the Matrix rooms Cortex is in (name + id). Use this to discover what channels exist before reading one with read_matrix_room. The result is delivered back to you as a follow-up message (async).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'list_matrix_rooms' }),
    });
    return ok('Fetching the list of Matrix rooms — it will arrive as a follow-up message.');
  },
};

export const readMatrixRoom: McpToolDefinition = {
  tool: {
    name: 'read_matrix_room',
    description:
      "Read recent messages from another Matrix room Cortex is in — useful when the user references something said in a different channel. Identify the room by name (e.g. \"ops\"; Cortex resolves it) or by room id. The decrypted messages are delivered back to you as a follow-up message (async). Only rooms Cortex has joined are readable.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        room: { type: 'string', description: 'Room name (e.g. "ops") or room id (e.g. "!abc:server").' },
        limit: { type: 'number', description: 'How many recent messages to fetch (default 30, max 100).' },
      },
      required: ['room'],
    },
  },
  async handler(args) {
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'read_matrix_room', room: args.room, limit: args.limit }),
    });
    return ok(`Reading recent messages from "${String(args.room)}" — they will arrive as a follow-up message.`);
  },
};

registerTools([createMatrixRoom, listMatrixRooms, readMatrixRoom]);
