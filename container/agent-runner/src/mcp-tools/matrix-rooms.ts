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
      'Create a new encrypted Matrix room and wire it to your agent group so it becomes its own session/conversation. Invite the given Matrix user(s). Optionally set a name/topic, post an opening message, and place the room inside a Matrix Space (e.g. the "Borgorg" space) by name or id. Use when the user asks you to start a new Matrix chat, channel, or room. Fire-and-forget: the room is created on the host asynchronously; a confirmation (incl. whether it was added to the space) arrives as a follow-up message.',
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
        space: {
          type: 'string',
          description:
            'Optional Matrix Space to place the room in, by name (e.g. "Borgorg") or space id. Cortex must be a member of the space with permission to add rooms.',
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
        space: args.space,
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

export const setMatrixAvatar: McpToolDefinition = {
  tool: {
    name: 'set_matrix_avatar',
    description:
      "Set Cortex's own Matrix profile picture (avatar) to an image file. Pass the path to an image the user sent you — inbound images are saved to an inbox path like /workspace/inbox/<id>/photo.jpg (shown in the message). Use when the user asks you to change your Matrix profile pic/avatar to an image they shared. Confirmation arrives as a follow-up message.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        image_path: {
          type: 'string',
          description: 'Path to the image file to use as the avatar (e.g. /workspace/inbox/<id>/photo.jpg).',
        },
      },
      required: ['image_path'],
    },
  },
  async handler(args) {
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'set_matrix_avatar', image_path: args.image_path }),
    });
    return ok("Updating Cortex's Matrix profile picture — confirmation will arrive as a follow-up message.");
  },
};

export const setMatrixRoomAvatar: McpToolDefinition = {
  tool: {
    name: 'set_matrix_room_avatar',
    description:
      "Set the avatar (photo) of a Matrix room or Space that Cortex has permission in — e.g. the \"Borgorg\" space. Pass the room/space by name or id, plus the path to an image the user sent (an inbox path like /workspace/inbox/<id>/photo.jpg). Use when the user asks you to change a room's or space's photo. Cortex needs power to change room state there; a confirmation (or a permission error) arrives as a follow-up message.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        room: {
          type: 'string',
          description: 'Room or Space by name (e.g. "Borgorg") or id (e.g. "!abc:server").',
        },
        image_path: {
          type: 'string',
          description: 'Path to the image file to use as the avatar (e.g. /workspace/inbox/<id>/photo.jpg).',
        },
      },
      required: ['room', 'image_path'],
    },
  },
  async handler(args) {
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'set_matrix_room_avatar', room: args.room, image_path: args.image_path }),
    });
    return ok(`Setting the avatar for "${String(args.room)}" — confirmation will arrive as a follow-up message.`);
  },
};

registerTools([createMatrixRoom, listMatrixRooms, readMatrixRoom, setMatrixAvatar, setMatrixRoomAvatar]);
