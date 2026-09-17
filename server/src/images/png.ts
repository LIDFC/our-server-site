import { deflateSync, inflateSync } from "node:zlib";

/** Decoded image, always 8 bit RGBA, four bytes per pixel. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Buffer;
}

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

export class ImageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/** Checksum of a PNG chunk. Exported so tests can build pictures the encoder here never produces. */
export function crc32(data: Buffer): number {
  let c = -1;
  for (const byte of data) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

export function isPng(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** Reads IHDR only. The size is known before anything is decompressed, so a huge image is refused early. */
export function readPngHeader(buffer: Buffer): PngHeader {
  if (!isPng(buffer) || buffer.length < 33) {
    throw new ImageError("not-png", "The file is not a PNG image");
  }
  if (buffer.toString("latin1", 12, 16) !== "IHDR") {
    throw new ImageError("broken-png", "The PNG image has no header chunk");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new ImageError("broken-png", "The PNG image has no size");
  }
  return { width, height, bitDepth: buffer[24]!, colorType: buffer[25]!, interlace: buffer[28]! };
}

function readSample(row: Buffer, index: number, bitDepth: number): number {
  if (bitDepth === 8) {
    return row[index]!;
  }
  if (bitDepth === 16) {
    // 16 bit samples are scaled down to 8 bit
    return row[index * 2]!;
  }
  const perByte = 8 / bitDepth;
  const byte = row[Math.floor(index / perByte)]!;
  const shift = 8 - bitDepth * (1 + (index % perByte));
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

function scale(value: number, bitDepth: number): number {
  if (bitDepth === 8 || bitDepth === 16) {
    return value;
  }
  const max = (1 << bitDepth) - 1;
  return Math.round((value * 255) / max);
}

/**
 * Decodes a PNG image into RGBA. Only what a Minecraft skin needs: no interlacing, sizes are checked by the caller
 * before this runs, and the inflated data is capped, so a small file cannot expand into gigabytes.
 */
export function decodePng(buffer: Buffer): RgbaImage {
  const header = readPngHeader(buffer);
  if (header.interlace !== 0) {
    throw new ImageError("png-interlaced", "The PNG image is interlaced, save it without interlacing");
  }
  const channels = CHANNELS[header.colorType];
  if (channels === undefined) {
    throw new ImageError("broken-png", "The PNG image uses an unknown colour type");
  }
  const allowedDepths = header.colorType === 3 ? [1, 2, 4, 8] : header.colorType === 0 ? [1, 2, 4, 8, 16] : [8, 16];
  if (!allowedDepths.includes(header.bitDepth)) {
    throw new ImageError("broken-png", "The PNG image uses an unsupported bit depth");
  }

  const parts: Buffer[] = [];
  let palette: Buffer | null = null;
  let paletteAlpha: Buffer | null = null;
  let transparent: number[] | null = null;
  let offset = 8;
  let sawEnd = false;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > buffer.length || dataEnd + 4 > buffer.length) {
      throw new ImageError("broken-png", "The PNG image is cut off");
    }
    const data = buffer.subarray(dataStart, dataEnd);
    if (buffer.readUInt32BE(dataEnd) !== crc32(buffer.subarray(offset + 4, dataEnd))) {
      throw new ImageError("broken-png", "The PNG image is damaged");
    }
    if (type === "IDAT") {
      parts.push(data);
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "tRNS") {
      if (header.colorType === 3) {
        paletteAlpha = Buffer.from(data);
      } else {
        transparent = [];
        for (let i = 0; i + 1 < data.length; i += 2) {
          transparent.push(data.readUInt16BE(i));
        }
      }
    } else if (type === "IEND") {
      sawEnd = true;
      break;
    }
    offset = dataEnd + 4;
  }
  if (!sawEnd || parts.length === 0) {
    throw new ImageError("broken-png", "The PNG image has no picture data");
  }
  if (header.colorType === 3 && !palette) {
    throw new ImageError("broken-png", "The PNG image has no colour palette");
  }

  const bitsPerPixel = channels * header.bitDepth;
  const bytesPerPixel = Math.ceil(bitsPerPixel / 8);
  const stride = Math.ceil((header.width * bitsPerPixel) / 8);
  const expected = (stride + 1) * header.height;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(parts), { maxOutputLength: expected });
  } catch {
    throw new ImageError("broken-png", "The PNG image cannot be unpacked");
  }
  if (raw.length !== expected) {
    throw new ImageError("broken-png", "The PNG image is incomplete");
  }

  const out = Buffer.alloc(header.width * header.height * 4);
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)]!;
    raw.copy(current, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= bytesPerPixel ? current[i - bytesPerPixel]! : 0;
      const up = previous[i]!;
      const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel]! : 0;
      let value = current[i]!;
      switch (filter) {
        case 0:
          break;
        case 1:
          value += left;
          break;
        case 2:
          value += up;
          break;
        case 3:
          value += (left + up) >> 1;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default:
          throw new ImageError("broken-png", "The PNG image uses an unknown row filter");
      }
      current[i] = value & 0xff;
    }

    for (let x = 0; x < header.width; x++) {
      const target = (y * header.width + x) * 4;
      if (header.colorType === 3) {
        const index = readSample(current, x, header.bitDepth);
        if ((index + 1) * 3 > palette!.length) {
          throw new ImageError("broken-png", "The PNG image points outside its palette");
        }
        out[target] = palette![index * 3]!;
        out[target + 1] = palette![index * 3 + 1]!;
        out[target + 2] = palette![index * 3 + 2]!;
        out[target + 3] = paletteAlpha && index < paletteAlpha.length ? paletteAlpha[index]! : 255;
        continue;
      }
      const base = x * channels;
      if (header.colorType === 0 || header.colorType === 4) {
        const grayRaw = readSample(current, base, header.bitDepth);
        const gray = scale(grayRaw, header.bitDepth);
        out[target] = gray;
        out[target + 1] = gray;
        out[target + 2] = gray;
        out[target + 3] =
          header.colorType === 4
            ? scale(readSample(current, base + 1, header.bitDepth), header.bitDepth)
            : transparent && transparent[0] === grayRaw
              ? 0
              : 255;
        continue;
      }
      const r = readSample(current, base, header.bitDepth);
      const g = readSample(current, base + 1, header.bitDepth);
      const b = readSample(current, base + 2, header.bitDepth);
      out[target] = scale(r, header.bitDepth);
      out[target + 1] = scale(g, header.bitDepth);
      out[target + 2] = scale(b, header.bitDepth);
      out[target + 3] =
        header.colorType === 6
          ? scale(readSample(current, base + 3, header.bitDepth), header.bitDepth)
          : transparent && transparent[0] === r && transparent[1] === g && transparent[2] === b
            ? 0
            : 255;
    }
    current.copy(previous);
  }

  return { width: header.width, height: header.height, data: out };
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/**
 * Writes a plain 8 bit RGBA PNG: no interlacing, no metadata. Everything the site stores goes through here, so an
 * uploaded file never reaches the disk with its original chunks, comments or colour profiles.
 */
export function encodePng(image: RgbaImage): Buffer {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new ImageError("broken-image", "The picture data does not match its size");
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    // filter 0: these pictures are 64 pixels wide, filtering would save almost nothing
    data.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
