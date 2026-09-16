import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseGallery } from "../src/services/gallery.ts";

const valid = {
  id: "house-by-the-lake",
  title: "Дом на берегу",
  author: "Alice",
  description: "Первый дом на сервере",
  image: "house-by-the-lake.webp",
  coords: { x: 123, y: 70, z: -456 },
  addedAt: "2026-09-16",
};

describe("gallery", () => {
  it("accepts valid entries", () => {
    const { items, problems } = parseGallery({ items: [valid] }, () => true);
    assert.deepEqual(problems, []);
    assert.deepEqual(items, [
      {
        id: "house-by-the-lake",
        title: "Дом на берегу",
        author: "Alice",
        description: "Первый дом на сервере",
        imageUrl: "/media/gallery/house-by-the-lake.webp",
        coords: { x: 123, y: 70, z: -456 },
        addedAt: "2026-09-16",
      },
    ]);
  });

  it("skips invalid entries and explains why", () => {
    const { items, problems } = parseGallery(
      {
        items: [
          valid,
          { ...valid, id: "traversal", image: "../../etc/passwd" },
          { ...valid, id: "fractional", coords: { x: 1.5, y: 70, z: 0 } },
          { ...valid, id: "too-high", coords: { x: 1, y: 900, z: 0 } },
          { ...valid, id: "house-by-the-lake" },
          { ...valid, id: "missing-image", image: "missing.webp" },
          { ...valid, id: "no-title", title: "  " },
        ],
      },
      (fileName) => fileName !== "missing.webp",
    );
    assert.equal(items.length, 1);
    assert.equal(problems.length, 6);
  });

  it("handles a file without items", () => {
    assert.equal(parseGallery({}, () => true).problems.length, 1);
    assert.deepEqual(parseGallery({ items: [] }, () => true), { items: [], problems: [] });
  });
});
