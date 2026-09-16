import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { ConfigError, loadConfig } from "../src/config.ts";
import { staticCandidates } from "../src/http.ts";
import { createRateLimiter } from "../src/rateLimit.ts";

const root = path.resolve("dist-test-root");

describe("static paths", () => {
  it("maps pages to their index files", () => {
    assert.deepEqual(staticCandidates(root, "/"), [path.join(root, "index.html")]);
    assert.deepEqual(staticCandidates(root, "/launcher"), [path.join(root, "launcher", "index.html"), path.join(root, "launcher.html")]);
    assert.deepEqual(staticCandidates(root, "/_astro/app.js"), [path.join(root, "_astro", "app.js")]);
  });

  it("never leaves the public directory", () => {
    for (const attack of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/a\\..\\..\\b", "/%00", "/.env", "/%E0%A4%A"]) {
      for (const candidate of staticCandidates(root, attack)) {
        assert.ok(candidate.startsWith(root + path.sep), `${attack} resolved to ${candidate}`);
        assert.ok(!candidate.includes(`${path.sep}.`), `${attack} resolved to a hidden file`);
      }
    }
    assert.deepEqual(staticCandidates(root, "/.env"), []);
  });
});

describe("rate limiter", () => {
  it("limits requests per client within a window", () => {
    const limiter = createRateLimiter({ windowSeconds: 60, maxRequests: 2 });
    try {
      assert.equal(limiter.check("a", 0).allowed, true);
      assert.equal(limiter.check("a", 1).allowed, true);
      const blocked = limiter.check("a", 2);
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.retryAfterSeconds, 60);
      assert.equal(limiter.check("b", 2).allowed, true, "other clients are not affected");
      assert.equal(limiter.check("a", 60_001).allowed, true, "the window resets");
    } finally {
      limiter.stop();
    }
  });

  it("does not grow without limit", () => {
    const limiter = createRateLimiter({ windowSeconds: 60, maxRequests: 10, maxClients: 3 });
    try {
      for (let i = 0; i < 10; i++) {
        limiter.check(`client-${i}`, 0);
      }
      assert.ok(limiter.size() <= 3);
    } finally {
      limiter.stop();
    }
  });
});

describe("configuration", () => {
  it("has working defaults", () => {
    const config = loadConfig({});
    assert.equal(config.port, 3000);
    assert.equal(config.minecraft.publicAddress, "mc.vin-off.site");
    assert.equal(config.map.url, null);
  });

  it("reports every invalid value at once", () => {
    assert.throws(
      () => loadConfig({ PORT: "99999", MC_WORLD: "../world", MAP_URL: "javascript:alert(1)", LAUNCHER_REPO: "nope" }),
      (error: unknown) => error instanceof ConfigError && error.message.split("\n- ").length === 5,
    );
  });

  it("normalizes the map URL", () => {
    assert.equal(loadConfig({ MAP_URL: "https://map.vin-off.site/" }).map.url, "https://map.vin-off.site");
  });
});
