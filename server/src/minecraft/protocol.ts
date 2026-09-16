/**
 * Server List Ping, the protocol of the multiplayer screen: https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping
 * Pure functions without network access.
 */

export const MAX_PACKET_LENGTH = 2 * 1024 * 1024;
const PROTOCOL_VERSION_UNKNOWN = -1;
const NEXT_STATE_STATUS = 1;
const MAX_SAMPLE_ENTRIES = 1000;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface PlayersInfo {
  online: number;
  max: number;
  /** names reported by the server, vanilla and Paper send at most 12 */
  sample: string[];
}

export interface StatusInfo {
  version: string | null;
  protocol: number | null;
  motd: string;
  /** null if the server does not report its players */
  players: PlayersInfo | null;
}

export type PacketRead =
  | { state: "complete"; id: number; payload: Buffer; size: number }
  | { state: "incomplete" }
  | { state: "invalid" };

export function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  // negative values take all five bytes
  let remaining = value >>> 0;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

export function readVarInt(data: Buffer, offset: number): { state: "complete"; value: number; size: number } | { state: "incomplete" | "invalid" } {
  let result = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= data.length) {
      return { state: "incomplete" };
    }
    const byte = data[offset + i]!;
    result |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) {
      return { state: "complete", value: result | 0, size: i + 1 };
    }
  }
  return { state: "invalid" };
}

export function readPacket(buffer: Buffer): PacketRead {
  const length = readVarInt(buffer, 0);
  if (length.state !== "complete") {
    return { state: length.state };
  }
  if (length.value <= 0 || length.value > MAX_PACKET_LENGTH) {
    return { state: "invalid" };
  }
  if (buffer.length - length.size < length.value) {
    return { state: "incomplete" };
  }
  const body = buffer.subarray(length.size, length.size + length.value);
  const id = readVarInt(body, 0);
  if (id.state !== "complete") {
    return { state: "invalid" };
  }
  return { state: "complete", id: id.value, payload: body.subarray(id.size), size: length.size + length.value };
}

function frame(id: number, payload: Buffer): Buffer {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

export function handshakePacket(host: string, port: number): Buffer {
  const hostBytes = Buffer.from(host, "utf8");
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  return frame(
    0x00,
    Buffer.concat([writeVarInt(PROTOCOL_VERSION_UNKNOWN), writeVarInt(hostBytes.length), hostBytes, portBytes, writeVarInt(NEXT_STATE_STATUS)]),
  );
}

export function statusRequestPacket(): Buffer {
  return frame(0x00, Buffer.alloc(0));
}

export function pingPacket(payload: bigint): Buffer {
  const data = Buffer.alloc(8);
  data.writeBigInt64BE(payload);
  return frame(0x01, data);
}

/** A player name as accepted by vanilla and Paper: 1 to 16 printable ASCII characters without spaces. */
export function isValidPlayerName(name: unknown): name is string {
  return typeof name === "string" && /^[\x21-\x7e]{1,16}$/.test(name);
}

/** Plain text of a chat component, formatting codes removed. */
export function flattenChat(value: unknown, depth = 0): string {
  if (depth > 16 || value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value.replace(/§./g, "");
  }
  if (Array.isArray(value)) {
    return value.map((part) => flattenChat(part, depth + 1)).join("");
  }
  if (typeof value === "object") {
    const component = value as { text?: unknown; extra?: unknown };
    return flattenChat(component.text ?? "", depth + 1) + flattenChat(component.extra ?? "", depth + 1);
  }
  return "";
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function parseStatusJson(json: unknown): StatusInfo | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return null;
  }
  const status = json as { version?: { name?: unknown; protocol?: unknown }; description?: unknown; players?: unknown };

  let players: PlayersInfo | null = null;
  if (status.players !== undefined) {
    if (typeof status.players !== "object" || status.players === null) {
      return null;
    }
    const raw = status.players as { online?: unknown; max?: unknown; sample?: unknown };
    const online = readCount(raw.online);
    const max = readCount(raw.max);
    if (online === null || max === null) {
      return null;
    }
    const sample: string[] = [];
    if (Array.isArray(raw.sample)) {
      for (const entry of raw.sample.slice(0, MAX_SAMPLE_ENTRIES)) {
        const player = entry as { name?: unknown; id?: unknown } | null;
        // placeholders such as "Anonymous Player" use the nil UUID
        if (player && player.id !== NIL_UUID && isValidPlayerName(player.name) && !sample.includes(player.name)) {
          sample.push(player.name);
        }
      }
    }
    players = { online, max, sample };
  }

  return {
    version: typeof status.version?.name === "string" ? flattenChat(status.version.name).slice(0, 64) : null,
    protocol: typeof status.version?.protocol === "number" ? status.version.protocol : null,
    motd: flattenChat(status.description).trim().slice(0, 256),
    players,
  };
}

export function parseStatusResponse(payload: Buffer): StatusInfo | null {
  const length = readVarInt(payload, 0);
  if (length.state !== "complete" || length.value <= 0 || payload.length - length.size < length.value) {
    return null;
  }
  try {
    return parseStatusJson(JSON.parse(payload.subarray(length.size, length.size + length.value).toString("utf8")));
  } catch {
    return null;
  }
}
