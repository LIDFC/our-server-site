import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

export function securityHeaders(mapUrl: string | null): Record<string, string> {
  const mapOrigin = mapUrl ? new URL(mapUrl).origin : null;
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // style attributes carry small dynamic values such as the status glow
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${mapOrigin ?? "'none'"}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, cacheSeconds = 0): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.setHeader("Cache-Control", cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store");
  res.end(payload);
}

export function sendError(res: ServerResponse, status: number, error: string, message: string): void {
  sendJson(res, status, { error, message });
}

export type JsonBody = { ok: true; value: Record<string, unknown> } | { ok: false; status: number; error: string; message: string };

/**
 * Reads a small JSON object from the request. Anything that is not a JSON object, or is larger than maxBytes, is
 * refused: the auth endpoints only ever take a handful of short fields.
 */
export async function readJsonBody(req: IncomingMessage, maxBytes = 2048): Promise<JsonBody> {
  const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, status: 415, error: "unsupported-media-type", message: "Send application/json" };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = chunk as Buffer;
    size += part.length;
    if (size > maxBytes) {
      return { ok: false, status: 413, error: "body-too-large", message: "The request body is too large" };
    }
    chunks.push(part);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return { ok: false, status: 400, error: "invalid-body", message: "The request body is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: "invalid-body", message: "The request body must be a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export type BinaryBody = { ok: true; value: Buffer } | { ok: false; status: number; error: string; message: string };

/**
 * Reads a raw upload with a hard limit. The limit is enforced while the bytes arrive, not afterwards, so an oversized
 * upload is dropped instead of being buffered.
 */
export async function readBinaryBody(req: IncomingMessage, maxBytes: number): Promise<BinaryBody> {
  const tooLarge = { ok: false as const, status: 413, error: "file-too-large", message: `The file must be at most ${maxBytes} bytes` };
  const declaredLength = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return tooLarge;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = chunk as Buffer;
    size += part.length;
    if (size > maxBytes) {
      // stop reading and answer; Node closes the connection instead of keeping the rest of the upload alive
      req.pause();
      return tooLarge;
    }
    chunks.push(part);
  }
  if (size === 0) {
    return { ok: false, status: 400, error: "empty-file", message: "The request had no file in it" };
  }
  return { ok: true, value: Buffer.concat(chunks) };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name && !(name in cookies)) {
      cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return cookies;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure?: boolean;
  path?: string;
}

/** Session cookie: never readable from JavaScript and not sent from other sites. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? "/"}`, "HttpOnly", "SameSite=Lax"];
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/**
 * Guards state changing requests: a browser always sends Origin on cross site POSTs, so rejecting a foreign Origin
 * together with SameSite=Lax cookies is enough, no CSRF token needed. Clients without an Origin (curl) are allowed.
 */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === "null") {
    return !origin;
  }
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Client address, taken from X-Real-IP only when the server runs behind a trusted reverse proxy. */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers["x-real-ip"];
    const value = Array.isArray(header) ? header[0] : header;
    if (value && isIP(value.trim())) {
      return value.trim();
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Maps a URL path to files inside rootDir. Returns candidates in lookup order, or an empty list for paths that try to
 * leave the directory or contain unusual characters.
 */
export function staticCandidates(rootDir: string, urlPath: string): string[] {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return [];
  }
  if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) {
    return [];
  }
  const root = path.resolve(rootDir);
  const target = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return [];
  }
  // hidden files are never served
  if (path.relative(root, target).split(path.sep).some((part) => part.startsWith("."))) {
    return [];
  }
  if (decoded.endsWith("/")) {
    return [path.join(target, "index.html")];
  }
  if (path.extname(target) === "") {
    return [path.join(target, "index.html"), `${target}.html`];
  }
  return [target];
}

function cacheControlFor(filePath: string): string {
  if (filePath.includes(`${path.sep}_astro${path.sep}`)) {
    // hashed build assets
    return "public, max-age=31536000, immutable";
  }
  if (filePath.endsWith(".html")) {
    return "no-cache";
  }
  return "public, max-age=3600";
}

/** Streams a file. Returns false if it does not exist, so the caller can try the next candidate. */
export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  status = 200,
  cacheControl?: string,
): Promise<boolean> {
  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  if (!contentType) {
    return false;
  }
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return false;
  }
  if (!info.isFile()) {
    return false;
  }

  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", info.size);
  res.setHeader("Last-Modified", info.mtime.toUTCString());
  res.setHeader("Cache-Control", cacheControl ?? cacheControlFor(filePath));
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  await new Promise<void>((resolve) => {
    const stream = createReadStream(filePath);
    stream.on("error", () => {
      res.destroy();
      resolve();
    });
    res.on("close", () => {
      stream.destroy();
      resolve();
    });
    stream.pipe(res);
  });
  return true;
}
