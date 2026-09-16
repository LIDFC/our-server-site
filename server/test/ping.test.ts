import assert from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";

import { pingServer } from "../src/minecraft/ping.ts";
import { readPacket, writeVarInt } from "../src/minecraft/protocol.ts";

function frame(id: number, payload: Buffer): Buffer {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

/** A minimal Minecraft server answering Server List Ping. */
async function fakeServer(status: unknown, options: { answerPing?: boolean } = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const packet = readPacket(buffer);
        if (packet.state !== "complete") {
          return;
        }
        buffer = buffer.subarray(packet.size);
        if (packet.id === 0 && packet.payload.length === 0) {
          const json = Buffer.from(JSON.stringify(status));
          socket.write(frame(0, Buffer.concat([writeVarInt(json.length), json])));
        } else if (packet.id === 1 && options.answerPing !== false) {
          socket.write(frame(1, packet.payload));
        }
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("pingServer", () => {
  it("returns the status and the measured latency", async () => {
    const server = await fakeServer({ version: { name: "Paper 1.21.11", protocol: 774 }, players: { online: 1, max: 10, sample: [{ name: "Alice", id: "x" }] } });
    try {
      const result = await pingServer("127.0.0.1", server.port, 3000);
      assert.equal(result.online, true);
      if (result.online) {
        assert.equal(result.version, "Paper 1.21.11");
        assert.deepEqual(result.players, { online: 1, max: 10, sample: ["Alice"] });
        assert.equal(typeof result.latencyMs, "number");
      }
    } finally {
      await server.close();
    }
  });

  it("keeps the status when the server does not answer the ping packet", async () => {
    const server = await fakeServer({ players: { online: 0, max: 10 } }, { answerPing: false });
    try {
      const result = await pingServer("127.0.0.1", server.port, 3000);
      assert.equal(result.online, true);
      if (result.online) {
        assert.equal(result.latencyMs, null);
      }
    } finally {
      await server.close();
    }
  });

  it("reports an unavailable server without inventing data", async () => {
    const server = await fakeServer({});
    const port = server.port;
    await server.close();
    const result = await pingServer("127.0.0.1", port, 3000);
    assert.equal(result.online, false);
    if (!result.online) {
      assert.ok(result.error.length > 0);
    }
  });
});
