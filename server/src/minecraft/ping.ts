import net from "node:net";

import { handshakePacket, pingPacket, readPacket, statusRequestPacket, type StatusInfo, parseStatusResponse } from "./protocol.ts";

export type PingResult = ({ online: true; latencyMs: number | null } & StatusInfo) | { online: false; error: string };

const PONG_TIMEOUT_MS = 2000;

/**
 * Asks a Minecraft server for its status and measures the latency with the ping packet. Never rejects: an unreachable
 * server is a regular result.
 */
export function pingServer(host: string, port: number, timeoutMs: number): Promise<PingResult> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let status: Extract<PingResult, { online: true }> | null = null;
    let pingStartedAt = 0;
    const pingPayload = BigInt(Date.now());
    let settled = false;

    const finish = (result: PingResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    // once the status is known, a missing pong only leaves the latency unknown
    const fail = (error: string): void => finish(status ?? { online: false, error });

    let timer = setTimeout(() => fail("timeout"), timeoutMs);

    socket.setNoDelay(true);
    socket.once("connect", () => socket.write(Buffer.concat([handshakePacket(host, port), statusRequestPacket()])));
    socket.on("error", (error: NodeJS.ErrnoException) => fail(error.code ?? "connection-error"));
    socket.on("close", () => fail("connection-closed"));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const packet = readPacket(buffer);
        if (packet.state === "incomplete") {
          return;
        }
        if (packet.state === "invalid") {
          fail("invalid-response");
          return;
        }
        buffer = buffer.subarray(packet.size);

        if (!status) {
          const info = packet.id === 0x00 ? parseStatusResponse(packet.payload) : null;
          if (!info) {
            fail("invalid-response");
            return;
          }
          status = { online: true, latencyMs: null, ...info };
          clearTimeout(timer);
          timer = setTimeout(() => fail("timeout"), PONG_TIMEOUT_MS);
          pingStartedAt = performance.now();
          socket.write(pingPacket(pingPayload));
          continue;
        }

        if (packet.id === 0x01 && packet.payload.length === 8 && packet.payload.readBigInt64BE(0) === pingPayload) {
          status.latencyMs = Math.max(0, Math.round(performance.now() - pingStartedAt));
        }
        finish(status);
        return;
      }
    });
  });
}
