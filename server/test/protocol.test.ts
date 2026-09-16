import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_PACKET_LENGTH,
  flattenChat,
  handshakePacket,
  isValidPlayerName,
  parseStatusJson,
  parseStatusResponse,
  pingPacket,
  readPacket,
  readVarInt,
  statusRequestPacket,
  writeVarInt,
} from "../src/minecraft/protocol.ts";

function statusPayload(json: unknown): Buffer {
  const data = Buffer.from(JSON.stringify(json), "utf8");
  return Buffer.concat([writeVarInt(data.length), data]);
}

describe("VarInt", () => {
  const cases: [number, string][] = [
    [0, "00"],
    [1, "01"],
    [127, "7f"],
    [128, "8001"],
    [255, "ff01"],
    [25565, "ddc701"],
    [2097151, "ffff7f"],
    [2147483647, "ffffffff07"],
    [-1, "ffffffff0f"],
  ];
  for (const [value, hex] of cases) {
    it(`encodes and decodes ${value}`, () => {
      assert.equal(writeVarInt(value).toString("hex"), hex);
      assert.deepEqual(readVarInt(Buffer.from(hex, "hex"), 0), { state: "complete", value, size: hex.length / 2 });
    });
  }

  it("reports incomplete and too long values", () => {
    assert.equal(readVarInt(Buffer.from("ff", "hex"), 0).state, "incomplete");
    assert.equal(readVarInt(Buffer.from("ffffffffff01", "hex"), 0).state, "invalid");
  });
});

describe("packets", () => {
  it("reads a complete packet and ignores trailing bytes", () => {
    const packet = pingPacket(42n);
    const read = readPacket(Buffer.concat([packet, Buffer.from("aabb", "hex")]));
    assert.equal(read.state, "complete");
    if (read.state === "complete") {
      assert.equal(read.id, 1);
      assert.equal(read.payload.readBigInt64BE(0), 42n);
      assert.equal(read.size, packet.length);
    }
  });

  it("waits for missing bytes and rejects broken lengths", () => {
    const packet = pingPacket(1n);
    assert.equal(readPacket(packet.subarray(0, packet.length - 1)).state, "incomplete");
    assert.equal(readPacket(Buffer.alloc(0)).state, "incomplete");
    assert.equal(readPacket(Buffer.from("00", "hex")).state, "invalid");
    assert.equal(readPacket(writeVarInt(MAX_PACKET_LENGTH + 1)).state, "invalid");
  });

  it("builds the handshake and status request", () => {
    const read = readPacket(handshakePacket("mc.example.com", 25565));
    assert.equal(read.state, "complete");
    if (read.state === "complete") {
      assert.equal(read.id, 0);
      assert.equal(read.payload.toString("hex"), `ffffffff0f0e${Buffer.from("mc.example.com").toString("hex")}63dd01`);
    }
    assert.equal(statusRequestPacket().toString("hex"), "0100");
  });
});

describe("status response", () => {
  it("parses players, version and the message of the day", () => {
    const status = parseStatusResponse(
      statusPayload({
        version: { name: "Paper 1.21.11", protocol: 774 },
        description: { text: "§aOur ", extra: [{ text: "Server" }] },
        players: {
          online: 3,
          max: 10,
          sample: [
            { name: "Alice", id: "00000000-0000-3000-8000-000000000001" },
            { name: "Bob", id: "00000000-0000-3000-8000-000000000002" },
            { name: "Anonymous Player", id: "00000000-0000-0000-0000-000000000000" },
            { name: "Two Words", id: "00000000-0000-3000-8000-000000000003" },
            { name: "Alice", id: "00000000-0000-3000-8000-000000000001" },
          ],
        },
      }),
    );
    assert.deepEqual(status, {
      version: "Paper 1.21.11",
      protocol: 774,
      motd: "Our Server",
      players: { online: 3, max: 10, sample: ["Alice", "Bob"] },
    });
  });

  it("keeps an unreported player count unknown instead of zero", () => {
    assert.equal(parseStatusJson({ version: { name: "Paper" }, description: "x" })?.players, null);
  });

  it("rejects malformed responses", () => {
    assert.equal(parseStatusJson({ players: { online: "3", max: 10 } }), null);
    assert.equal(parseStatusJson({ players: { online: -1, max: 10 } }), null);
    assert.equal(parseStatusJson({ players: { online: 2 } }), null);
    assert.equal(parseStatusJson([]), null);
    assert.equal(parseStatusResponse(Buffer.concat([writeVarInt(5), Buffer.from("hello")])), null);
    assert.equal(parseStatusResponse(statusPayload({ players: { online: 1, max: 2 } }).subarray(0, 10)), null);
  });

  it("validates player names like the server does", () => {
    assert.ok(isValidPlayerName("Steve"));
    assert.ok(isValidPlayerName("SixteenCharsName"));
    assert.ok(!isValidPlayerName("SeventeenCharName"));
    assert.ok(!isValidPlayerName(""));
    assert.ok(!isValidPlayerName("§cRed"));
  });

  it("flattens nested chat components", () => {
    assert.equal(flattenChat(["a", { text: "b", extra: [{ text: "§lc" }] }]), "abc");
  });
});
