import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * scrypt from node:crypto: memory hard and part of Node, so the site keeps its zero runtime dependencies. Argon2id and
 * bcrypt both need a native module. These parameters cost about 80 ms and 34 MB per hash.
 */
const COST = 32768;
const BLOCK_SIZE = 8;
const PARALLEL = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
const MAX_MEMORY = 128 * COST * BLOCK_SIZE * 2;

function derive(password: string, salt: Buffer, cost: number, blockSize: number, parallel: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_BYTES, { N: cost, r: blockSize, p: parallel, maxmem: MAX_MEMORY }, (error, key) => {
      if (error) {
        reject(error);
      } else {
        resolve(key);
      }
    });
  });
}

/** Returns scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>. The parameters travel with the hash, so they can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST, BLOCK_SIZE, PARALLEL);
  return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLEL}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallel = Number(parts[3]);
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallel) || cost < 1024 || cost > 1 << 20) {
    return false;
  }
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (salt.length === 0 || expected.length !== KEY_BYTES) {
    return false;
  }
  let key: Buffer;
  try {
    key = await derive(password, salt, cost, blockSize, parallel);
  } catch {
    return false;
  }
  return timingSafeEqual(key, expected);
}

/**
 * Same work as a real check, for logins that do not exist. Without it an unknown account would answer noticeably
 * faster than a wrong password and that difference alone lists the accounts.
 */
export async function spendVerifyTime(password: string): Promise<void> {
  await derive(password, randomBytes(SALT_BYTES), COST, BLOCK_SIZE, PARALLEL);
}
