import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderHead } from "../src/images/head.ts";
import { decodePng, encodePng, type RgbaImage } from "../src/images/png.ts";
import { parseItem } from "../../src/scripts/items.ts";

/**
 * The two pieces that turn the marketplace's plain text into something to look at. Both are pure, so they are tested
 * without a server and without a browser.
 */

function blankSkin(width = 64, height = 64): RgbaImage {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

function put(image: RgbaImage, x: number, y: number, rgba: [number, number, number, number]): void {
  const at = (y * image.width + x) * 4;
  image.data[at] = rgba[0];
  image.data[at + 1] = rgba[1];
  image.data[at + 2] = rgba[2];
  image.data[at + 3] = rgba[3];
}

function pixelOf(image: RgbaImage, x: number, y: number): [number, number, number, number] {
  const at = (y * image.width + x) * 4;
  return [image.data[at]!, image.data[at + 1]!, image.data[at + 2]!, image.data[at + 3]!];
}

describe("reading an item out of the marketplace's wording", () => {
  it("takes the count, the material and the name apart", () => {
    assert.deepEqual(parseItem("16x diamond"), { id: "diamond", count: 16, label: "Diamond", renamed: false });
    assert.deepEqual(parseItem("1x diamond pickaxe"), { id: "diamond_pickaxe", count: 1, label: "Diamond pickaxe", renamed: false });
    assert.deepEqual(parseItem("64x gold ingot"), { id: "gold_ingot", count: 64, label: "Gold ingot", renamed: false });
  });

  it("keeps the name its owner gave an item, and still finds the material", () => {
    const named = parseItem("1x Сокрушитель (diamond pickaxe)");
    assert.equal(named.id, "diamond_pickaxe");
    assert.equal(named.label, "Сокрушитель");
    assert.equal(named.renamed, true);
    assert.equal(named.count, 1);
  });

  it("reads the material from the last brackets, not the first", () => {
    // the plugin always appends the material last, so a name with its own brackets cannot fool it
    const tricky = parseItem("3x Меч (лучший) (netherite sword)");
    assert.equal(tricky.id, "netherite_sword");
    assert.equal(tricky.label, "Меч (лучший)");
  });

  it("survives wording it has never seen", () => {
    assert.equal(parseItem("diamond").count, 1);
    assert.equal(parseItem("diamond").id, "diamond");
    assert.equal(parseItem("").id, "");
  });
});

describe("the face out of a skin", () => {
  it("takes the face from where a skin always keeps it", () => {
    const skin = blankSkin();
    put(skin, 8, 8, [10, 20, 30, 255]);
    put(skin, 15, 15, [200, 100, 50, 255]);

    const head = renderHead(skin, 4);
    assert.equal(head.width, 32);
    assert.equal(head.height, 32);
    assert.deepEqual(pixelOf(head, 0, 0), [10, 20, 30, 255]);
    assert.deepEqual(pixelOf(head, 31, 31), [200, 100, 50, 255]);
  });

  it("draws the hat over the face", () => {
    const skin = blankSkin();
    put(skin, 8, 8, [0, 0, 0, 255]);
    put(skin, 40, 8, [255, 255, 255, 255]);

    const head = renderHead(skin, 1);
    assert.deepEqual(pixelOf(head, 0, 0), [255, 255, 255, 255], "the hat wins where it is solid");
  });

  it("scales by whole pixels, so eight pixels stay eight pixels", () => {
    const skin = blankSkin();
    put(skin, 8, 8, [255, 0, 0, 255]);
    const head = renderHead(skin, 8);
    assert.equal(head.width, 64);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        assert.deepEqual(pixelOf(head, x, y), [255, 0, 0, 255], `pixel ${x},${y} is a whole block of colour`);
      }
    }
    assert.notDeepEqual(pixelOf(head, 8, 0), [255, 0, 0, 255], "and the next one is a different pixel, not a blend");
  });

  it("never leaves a hole in a head", () => {
    const head = renderHead(blankSkin(), 1);
    for (let i = 3; i < head.data.length; i += 4) {
      assert.equal(head.data[i], 255, "every pixel is opaque");
    }
  });

  it("works on the old 64x32 skin layout and refuses anything smaller", () => {
    const old = blankSkin(64, 32);
    put(old, 8, 8, [1, 2, 3, 255]);
    assert.deepEqual(pixelOf(renderHead(old, 1), 0, 0), [1, 2, 3, 255]);
    assert.throws(() => renderHead(blankSkin(16, 16), 1), /too small/);
  });

  it("comes out as a real PNG", () => {
    const skin = blankSkin();
    put(skin, 8, 8, [90, 140, 200, 255]);
    const again = decodePng(encodePng(renderHead(skin, 8)));
    assert.equal(again.width, 64);
    assert.deepEqual(pixelOf(again, 0, 0), [90, 140, 200, 255]);
  });
});
