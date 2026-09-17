import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateSync } from "node:zlib";

import { decodeJpeg, readJpegSize } from "../src/images/jpeg.ts";
import { crc32, decodePng, encodePng, ImageError, PNG_SIGNATURE, readPngHeader } from "../src/images/png.ts";
import { readSkin, sniffType } from "../src/images/skin.ts";

/** A 64x64 baseline JPEG made with System.Drawing: red grows to the right, green downwards, blue is 128. */
const JPEG_64 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/" +
    "2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCABAAEADASIAAhEBAxEB/8QA" +
    "HwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK" +
    "FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG" +
    "x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC" +
    "AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE" +
    "hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD88rTSunFb" +
    "NppXT5a2bTSunFbNppXT5a/oOtjPM8rLcw21Me00rp8tbNppPT5a2bTSuny1s2mk9Plrwq2M8z9Vy3MNtTHtNK6fLWzaaV04rZtNK6cVs2mldOK8KtjPM/Vs" +
    "tzDbUx7TSunFbNppXTitm00rpxWzaaV0+WvCrYzzP1XLcw21Pn+00rp8tbNppXT5a2bTSuny1s2mldPlr3q2M8z/AC3y3H7amPaaT0+Wtm00rp8tbNppPT5a" +
    "2bTSunFeFWxnmfquW4/bUx7TSunFbNppXTitm00rpxW1aaV04rw62M8z9Wy3H7amNaaV04ratNK6fLWxaaV0+Wtq00rp8teFWxnmfquW4/bU+frTSuny1tWm" +
    "k9PlrYtNK6fLW1aaT0+WverYzzP8uMtx+2pjWmldPlratNK6cVsWmldOK2rTSuny14VbGeZ+q5bj9tTGtNK6cVtWmldOK2LTSunFbVppXT5a8KtjPM/Vstx+" +
    "2pjWmldPlratNK6fLWxaaV0+Wtq00rp8teFWxnmfquW4/bU+frTSeny1tWmldPlrYtNJ6fLW1aaV04r3q2M8z/LfLcftqY1ppXTitq00rpxWxaaV0+Wtq00r" +
    "pxXhVsZ5n6tluP21Ma00rpxW1aaV0+Wti00rp8tbVppXT5a8KtjPM/Vctx+2pjWmldPlratNK6fLWxaaV0+Wtq00rp8teHWxnmfquW4/bU//2Q==",
  "base64",
);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

interface PngOptions {
  width: number;
  height: number;
  colorType: number;
  bitDepth: number;
  /** raw scanlines without the filter byte */
  rows: Buffer;
  filter?: number;
  palette?: Buffer;
  transparency?: Buffer;
  interlace?: number;
}

/** Builds a PNG by hand, so the decoder can be tested with pictures the encoder here never writes. */
function makePng(options: PngOptions): Buffer {
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const stride = Math.ceil((options.width * channels[options.colorType]! * options.bitDepth) / 8);
  const filter = options.filter ?? 0;
  const bytesPerPixel = Math.max(1, Math.ceil((channels[options.colorType]! * options.bitDepth) / 8));
  const filtered = Buffer.alloc((stride + 1) * options.height);
  for (let y = 0; y < options.height; y++) {
    filtered[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const value = options.rows[y * stride + i]!;
      const left = i >= bytesPerPixel ? options.rows[y * stride + i - bytesPerPixel]! : 0;
      const up = y > 0 ? options.rows[(y - 1) * stride + i]! : 0;
      const upLeft = y > 0 && i >= bytesPerPixel ? options.rows[(y - 1) * stride + i - bytesPerPixel]! : 0;
      let encoded = value;
      if (filter === 1) {
        encoded = value - left;
      } else if (filter === 2) {
        encoded = value - up;
      } else if (filter === 3) {
        encoded = value - ((left + up) >> 1);
      } else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        encoded = value - (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      filtered[y * (stride + 1) + 1 + i] = encoded & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(options.width, 0);
  ihdr.writeUInt32BE(options.height, 4);
  ihdr[8] = options.bitDepth;
  ihdr[9] = options.colorType;
  ihdr[12] = options.interlace ?? 0;
  const parts = [PNG_SIGNATURE, chunk("IHDR", ihdr)];
  if (options.palette) {
    parts.push(chunk("PLTE", options.palette));
  }
  if (options.transparency) {
    parts.push(chunk("tRNS", options.transparency));
  }
  parts.push(chunk("IDAT", deflateSync(filtered)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function rgbaSkin(width = 64, height = 64): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      data[at] = (x * 4) % 256;
      data[at + 1] = (y * 4) % 256;
      data[at + 2] = 128;
      // the top left corner is transparent, as in a real skin
      data[at + 3] = x < 8 && y < 8 ? 0 : 255;
    }
  }
  return data;
}

describe("PNG", () => {
  it("writes and reads back the same pixels", () => {
    const data = rgbaSkin();
    const file = encodePng({ width: 64, height: 64, data });
    const header = readPngHeader(file);
    assert.deepEqual(header, { width: 64, height: 64, bitDepth: 8, colorType: 6, interlace: 0 });
    const decoded = decodePng(file);
    assert.equal(decoded.width, 64);
    assert.ok(decoded.data.equals(data));
  });

  it("reads every row filter", () => {
    const rows = Buffer.alloc(64 * 64 * 4);
    rgbaSkin().copy(rows);
    for (const filter of [0, 1, 2, 3, 4]) {
      const decoded = decodePng(makePng({ width: 64, height: 64, colorType: 6, bitDepth: 8, rows, filter }));
      assert.ok(decoded.data.equals(rows), `filter ${filter}`);
    }
  });

  it("reads grey, palette, transparency and 16 bit pictures", () => {
    const grey = Buffer.alloc(64 * 64, 200);
    const fromGrey = decodePng(makePng({ width: 64, height: 64, colorType: 0, bitDepth: 8, rows: grey }));
    assert.deepEqual([...fromGrey.data.subarray(0, 4)], [200, 200, 200, 255]);

    // four colours, two bits per pixel
    const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const indexed = Buffer.alloc((64 / 4) * 64, 0b00011011);
    const fromPalette = decodePng(
      makePng({ width: 64, height: 64, colorType: 3, bitDepth: 2, rows: indexed, palette, transparency: Buffer.from([0, 255, 255, 255]) }),
    );
    assert.deepEqual([...fromPalette.data.subarray(0, 8)], [255, 0, 0, 0, 0, 255, 0, 255], "the first palette colour is transparent");

    const deep = Buffer.alloc(64 * 64 * 8);
    for (let i = 0; i < 64 * 64; i++) {
      deep.writeUInt16BE(0x8080, i * 8);
      deep.writeUInt16BE(0x4040, i * 8 + 2);
      deep.writeUInt16BE(0x2020, i * 8 + 4);
      deep.writeUInt16BE(0xffff, i * 8 + 6);
    }
    const from16 = decodePng(makePng({ width: 64, height: 64, colorType: 6, bitDepth: 16, rows: deep }));
    assert.deepEqual([...from16.data.subarray(0, 4)], [0x80, 0x40, 0x20, 255]);

    const greyAlpha = Buffer.alloc(64 * 64 * 2);
    greyAlpha.fill(0x10);
    const fromGreyAlpha = decodePng(makePng({ width: 64, height: 64, colorType: 4, bitDepth: 8, rows: greyAlpha }));
    assert.deepEqual([...fromGreyAlpha.data.subarray(0, 4)], [0x10, 0x10, 0x10, 0x10]);
  });

  it("refuses pictures it cannot trust", () => {
    const rows = rgbaSkin();
    const good = makePng({ width: 64, height: 64, colorType: 6, bitDepth: 8, rows });

    const interlaced = makePng({ width: 64, height: 64, colorType: 6, bitDepth: 8, rows, interlace: 1 });
    assert.throws(() => decodePng(interlaced), (error: ImageError) => error.code === "png-interlaced");

    const damaged = Buffer.from(good);
    damaged.writeUInt8(damaged.readUInt8(good.length - 20) ^ 0xff, good.length - 20);
    assert.throws(() => decodePng(damaged), (error: ImageError) => error.code === "broken-png");

    assert.throws(() => decodePng(good.subarray(0, good.length - 40)), (error: ImageError) => error.code === "broken-png");
    assert.throws(() => readPngHeader(Buffer.alloc(64)), (error: ImageError) => error.code === "not-png");
  });

  it("reads the size of a huge picture without unpacking it", () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(30000, 0);
    header.writeUInt32BE(30000, 4);
    header[8] = 8;
    header[9] = 6;
    const claimed = Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header)]);
    // the size is known from the first chunk, so a decompression bomb is refused before any memory is spent
    assert.deepEqual(readPngHeader(claimed), { width: 30000, height: 30000, bitDepth: 8, colorType: 6, interlace: 0 });
    assert.throws(() => readSkin(claimed, "image/png", null), (error: ImageError) => error.code === "bad-size");
  });
});

describe("JPEG", () => {
  it("reads the size from the header", () => {
    assert.deepEqual(readJpegSize(JPEG_64), { width: 64, height: 64 });
  });

  it("decodes a baseline photo", () => {
    const decoded = decodeJpeg(JPEG_64);
    assert.equal(decoded.width, 64);
    assert.equal(decoded.height, 64);
    const pixel = (x: number, y: number): number[] => [...decoded.data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];
    // JPEG is lossy, the colours only have to be close to what was drawn
    const close = (actual: number[], expected: number[]): void => {
      for (let i = 0; i < 4; i++) {
        assert.ok(Math.abs(actual[i]! - expected[i]!) <= 12, `${actual} is not close to ${expected}`);
      }
    };
    close(pixel(10, 10), [40, 40, 128, 255]);
    close(pixel(60, 10), [240, 40, 128, 255]);
    close(pixel(10, 60), [40, 240, 128, 255]);
    assert.equal(pixel(0, 0)[3], 255, "a converted JPEG is fully opaque");
  });

  it("refuses a progressive JPEG with a clear reason", () => {
    const progressive = Buffer.from(JPEG_64);
    // turn the baseline frame marker into the progressive one
    const marker = progressive.indexOf(Buffer.from([0xff, 0xc0]));
    progressive[marker + 1] = 0xc2;
    assert.throws(() => readJpegSize(progressive), (error: ImageError) => error.code === "jpeg-progressive");
  });
});

describe("skin files", () => {
  const png64 = encodePng({ width: 64, height: 64, data: rgbaSkin() });
  const png32 = encodePng({ width: 64, height: 32, data: rgbaSkin(64, 32) });

  it("knows what a file really is", () => {
    assert.equal(sniffType(png64), "image/png");
    assert.equal(sniffType(JPEG_64), "image/jpeg");
    assert.equal(sniffType(Buffer.from("GIF89a" + "x".repeat(32))), "image/gif");
    assert.equal(sniffType(Buffer.concat([Buffer.from("RIFF1234WEBPVP8 "), Buffer.alloc(16)])), "image/webp");
    assert.equal(sniffType(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')), "image/svg+xml");
    assert.equal(sniffType(Buffer.from("<svg width='64'></svg>")), "image/svg+xml");
    assert.equal(sniffType(Buffer.from("PK" + "x".repeat(32), "latin1")), "application/zip");
    assert.equal(sniffType(Buffer.from("MZ" + "x".repeat(32), "latin1")), "application/x-executable");
    assert.equal(sniffType(Buffer.from("%PDF-1.7" + "x".repeat(32))), "application/pdf");
    assert.equal(sniffType(Buffer.alloc(64, 7)), "application/octet-stream");
  });

  it("accepts a 64x64 PNG and writes it out again", () => {
    const skin = readSkin(png64, "image/png", "steve.png");
    assert.equal(skin.width, 64);
    assert.equal(skin.height, 64);
    assert.equal(skin.converted, false);
    assert.equal(sniffType(skin.png), "image/png");
    assert.deepEqual([...decodePng(skin.png).data.subarray(0, 4)], [0, 0, 128, 0], "transparency survives");
  });

  it("accepts a legacy 64x32 skin", () => {
    const skin = readSkin(png32, "image/png", "old.png");
    assert.equal(skin.height, 32);
  });

  it("turns a JPG into a real PNG texture", () => {
    const skin = readSkin(JPEG_64, "image/jpeg", "me.jpg");
    assert.equal(skin.converted, true);
    assert.equal(sniffType(skin.png), "image/png", "the stored file is a PNG, not a renamed JPG");
    const decoded = decodePng(skin.png);
    assert.equal(decoded.width, 64);
    assert.equal(decoded.height, 64);
  });

  it("refuses everything that is not a skin", () => {
    const cases: [Buffer, string | null, string | null, string][] = [
      [Buffer.from("GIF89a" + "x".repeat(64)), "image/gif", "a.gif", "format-gif"],
      [Buffer.concat([Buffer.from("RIFF1234WEBPVP8 "), Buffer.alloc(32)]), "image/webp", "a.webp", "format-webp"],
      [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "image/svg+xml", "a.svg", "format-svg"],
      [Buffer.from("PK" + "x".repeat(64), "latin1"), "application/zip", "a.zip", "format-archive"],
      [Buffer.from("MZ" + "x".repeat(64), "latin1"), "application/octet-stream", "a.exe", "format-executable"],
      [Buffer.alloc(64, 3), "image/png", "a.png", "format-unknown"],
      [Buffer.alloc(4), "image/png", "a.png", "empty-file"],
      // a JPEG that only pretends to be a PNG
      [JPEG_64, "image/png", "spoofed.png", "type-mismatch"],
      // a real PNG saved under a JPG name
      [png64, null, "wrong.jpg", "extension-mismatch"],
      [encodePng({ width: 32, height: 32, data: Buffer.alloc(32 * 32 * 4, 255) }), "image/png", "small.png", "bad-size"],
    ];
    for (const [buffer, declared, name, code] of cases) {
      assert.throws(
        () => readSkin(buffer, declared, name),
        (error: ImageError) => error.code === code,
        `${name ?? "file"} should fail with ${code}`,
      );
    }
  });

  it("refuses a picture that is cut in half", () => {
    assert.throws(() => readSkin(png64.subarray(0, png64.length - 30), "image/png", "cut.png"), (error: ImageError) => error.code === "broken-png");
  });
});
