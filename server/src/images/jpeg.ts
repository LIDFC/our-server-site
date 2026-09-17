import { ImageError, type RgbaImage } from "./png.ts";

/**
 * Baseline JPEG decoder, enough to turn a photo sized like a Minecraft skin into pixels. Progressive JPEGs and the rare
 * arithmetic coded ones are refused with a clear message: the site then asks for a PNG instead of guessing.
 */

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50,
  43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

interface HuffmanTable {
  /** code length (1 to 16) to code value to symbol */
  levels: Map<number, number>[];
}

interface Component {
  id: number;
  h: number;
  v: number;
  quantTable: number;
  dcTable: number;
  acTable: number;
  blocksPerLine: number;
  blocksPerColumn: number;
  coefficients: Int16Array;
  samples: Uint8Array;
}

export function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

/** Reads the frame header only, so the size can be checked before any pixel is decoded. */
export function readJpegSize(buffer: Buffer): { width: number; height: number } {
  if (!isJpeg(buffer)) {
    throw new ImageError("not-jpeg", "The file is not a JPEG image");
  }
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xc0 || marker === 0xc1) {
      if (offset + 9 > buffer.length) {
        break;
      }
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (marker === 0xc2 || marker === 0xc3 || (marker >= 0xc5 && marker <= 0xcf)) {
      throw new ImageError("jpeg-progressive", "This JPEG is progressive, save the skin as PNG");
    }
    if (marker === 0xda || marker === 0xd9) {
      break;
    }
    offset += 2 + length;
  }
  throw new ImageError("broken-jpeg", "The JPEG image has no frame header");
}

function buildHuffmanTable(counts: Buffer, symbols: Buffer): HuffmanTable {
  const levels: Map<number, number>[] = Array.from({ length: 17 }, () => new Map<number, number>());
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < counts[length - 1]!; i++) {
      levels[length]!.set(code, symbols[index]!);
      code++;
      index++;
    }
    code <<= 1;
  }
  return { levels };
}

function idct(block: Int32Array, out: Uint8Array, outOffset: number, stride: number): void {
  const temp = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          const coefficient = block[v * 8 + u]!;
          if (coefficient === 0) {
            continue;
          }
          const cu = u === 0 ? Math.SQRT1_2 : 1;
          const cv = v === 0 ? Math.SQRT1_2 : 1;
          sum += cu * cv * coefficient * Math.cos(((2 * x + 1) * u * Math.PI) / 16) * Math.cos(((2 * y + 1) * v * Math.PI) / 16);
        }
      }
      temp[y * 8 + x] = sum / 4;
    }
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const value = Math.round(temp[y * 8 + x]! + 128);
      out[outOffset + y * stride + x] = value < 0 ? 0 : value > 255 ? 255 : value;
    }
  }
}

export function decodeJpeg(buffer: Buffer): RgbaImage {
  const size = readJpegSize(buffer);
  const quantTables: (Uint16Array | undefined)[] = [];
  const dcTables: (HuffmanTable | undefined)[] = [];
  const acTables: (HuffmanTable | undefined)[] = [];
  let components: Component[] = [];
  let maxH = 1;
  let maxV = 1;
  let mcusPerLine = 0;
  let mcusPerColumn = 0;
  let restartInterval = 0;

  const prepareFrame = (raw: { id: number; h: number; v: number; quantTable: number }[]): void => {
    maxH = Math.max(...raw.map((item) => item.h));
    maxV = Math.max(...raw.map((item) => item.v));
    mcusPerLine = Math.ceil(size.width / (8 * maxH));
    mcusPerColumn = Math.ceil(size.height / (8 * maxV));
    components = raw.map((item) => {
      const blocksPerLine = mcusPerLine * item.h;
      const blocksPerColumn = mcusPerColumn * item.v;
      return {
        ...item,
        dcTable: 0,
        acTable: 0,
        blocksPerLine,
        blocksPerColumn,
        coefficients: new Int16Array(blocksPerLine * blocksPerColumn * 64),
        samples: new Uint8Array(blocksPerLine * 8 * blocksPerColumn * 8),
      };
    });
  };

  const decodeScan = (scanComponents: Component[], start: number): number => {
    let offset = start;
    let bitBuffer = 0;
    let bitCount = 0;
    let markerHit = false;

    const nextBit = (): number => {
      if (bitCount === 0) {
        if (offset >= buffer.length) {
          markerHit = true;
          return 0;
        }
        let byte = buffer[offset++]!;
        if (byte === 0xff) {
          const next = buffer[offset]!;
          if (next === 0x00) {
            offset++;
          } else {
            markerHit = true;
            offset--;
            byte = 0;
          }
        }
        bitBuffer = byte;
        bitCount = 8;
      }
      bitCount--;
      return (bitBuffer >> bitCount) & 1;
    };

    const decodeSymbol = (table: HuffmanTable | undefined): number => {
      if (!table) {
        throw new ImageError("broken-jpeg", "The JPEG image refers to a missing table");
      }
      let code = 0;
      for (let length = 1; length <= 16; length++) {
        code = (code << 1) | nextBit();
        const symbol = table.levels[length]!.get(code);
        if (symbol !== undefined) {
          return symbol;
        }
      }
      throw new ImageError("broken-jpeg", "The JPEG image has damaged compressed data");
    };

    const receive = (length: number): number => {
      let value = 0;
      for (let i = 0; i < length; i++) {
        value = (value << 1) | nextBit();
      }
      return value;
    };

    const extend = (value: number, length: number): number => (length === 0 ? 0 : value < 1 << (length - 1) ? value - (1 << length) + 1 : value);

    const predictors = new Map<number, number>();
    const decodeBlock = (component: Component, blockRow: number, blockColumn: number): void => {
      if (blockRow >= component.blocksPerColumn || blockColumn >= component.blocksPerLine) {
        return;
      }
      const target = (blockRow * component.blocksPerLine + blockColumn) * 64;
      const dcLength = decodeSymbol(dcTables[component.dcTable]);
      const diff = extend(receive(dcLength), dcLength);
      const dc = (predictors.get(component.id) ?? 0) + diff;
      predictors.set(component.id, dc);
      component.coefficients[target] = dc;
      let index = 1;
      while (index < 64) {
        const symbol = decodeSymbol(acTables[component.acTable]);
        const run = symbol >> 4;
        const magnitude = symbol & 15;
        if (magnitude === 0) {
          if (run !== 15) {
            break;
          }
          index += 16;
          continue;
        }
        index += run;
        if (index > 63) {
          break;
        }
        component.coefficients[target + ZIGZAG[index]!] = extend(receive(magnitude), magnitude);
        index++;
      }
    };

    const single = scanComponents.length === 1;
    const totalMcus = single
      ? Math.ceil(scanComponents[0]!.blocksPerLine / 1) * scanComponents[0]!.blocksPerColumn
      : mcusPerLine * mcusPerColumn;
    let sinceRestart = 0;
    for (let mcu = 0; mcu < totalMcus && !markerHit; mcu++) {
      if (single) {
        const component = scanComponents[0]!;
        decodeBlock(component, Math.floor(mcu / component.blocksPerLine), mcu % component.blocksPerLine);
      } else {
        const row = Math.floor(mcu / mcusPerLine);
        const column = mcu % mcusPerLine;
        for (const component of scanComponents) {
          for (let v = 0; v < component.v; v++) {
            for (let h = 0; h < component.h; h++) {
              decodeBlock(component, row * component.v + v, column * component.h + h);
            }
          }
        }
      }
      sinceRestart++;
      if (restartInterval > 0 && sinceRestart === restartInterval && mcu + 1 < totalMcus) {
        // a restart marker ends the bit stream, skip it and start over with fresh predictors
        bitCount = 0;
        sinceRestart = 0;
        while (offset + 1 < buffer.length && !(buffer[offset] === 0xff && buffer[offset + 1]! >= 0xd0 && buffer[offset + 1]! <= 0xd7)) {
          offset++;
        }
        offset += 2;
        markerHit = false;
        predictors.clear();
      }
    }

    // skip to the next marker
    while (offset + 1 < buffer.length && !(buffer[offset] === 0xff && buffer[offset + 1] !== 0x00 && !(buffer[offset + 1]! >= 0xd0 && buffer[offset + 1]! <= 0xd7))) {
      offset++;
    }
    return offset;
  };

  let offset = 2;
  let sawScan = false;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1]!;
    if (marker === 0xd9) {
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    const segment = buffer.subarray(offset + 4, offset + 2 + length);

    if (marker === 0xdb) {
      let position = 0;
      while (position < segment.length) {
        const precision = segment[position]! >> 4;
        const id = segment[position]! & 15;
        position++;
        const table = new Uint16Array(64);
        for (let i = 0; i < 64; i++) {
          table[ZIGZAG[i]!] = precision === 0 ? segment[position + i]! : segment.readUInt16BE(position + i * 2);
        }
        position += precision === 0 ? 64 : 128;
        quantTables[id] = table;
      }
    } else if (marker === 0xc4) {
      let position = 0;
      while (position + 17 <= segment.length) {
        const kind = segment[position]! >> 4;
        const id = segment[position]! & 15;
        const counts = segment.subarray(position + 1, position + 17);
        let total = 0;
        for (const count of counts) {
          total += count;
        }
        const symbols = segment.subarray(position + 17, position + 17 + total);
        const table = buildHuffmanTable(counts, symbols);
        if (kind === 0) {
          dcTables[id] = table;
        } else {
          acTables[id] = table;
        }
        position += 17 + total;
      }
    } else if (marker === 0xdd) {
      restartInterval = segment.readUInt16BE(0);
    } else if (marker === 0xc0 || marker === 0xc1) {
      const count = segment[5]!;
      const raw: { id: number; h: number; v: number; quantTable: number }[] = [];
      for (let i = 0; i < count; i++) {
        const base = 6 + i * 3;
        raw.push({ id: segment[base]!, h: segment[base + 1]! >> 4, v: segment[base + 1]! & 15, quantTable: segment[base + 2]! });
      }
      if (raw.length !== 1 && raw.length !== 3) {
        throw new ImageError("broken-jpeg", "The JPEG image uses an unsupported colour model");
      }
      prepareFrame(raw);
    } else if (marker === 0xc2 || marker === 0xc3 || (marker >= 0xc5 && marker <= 0xcf)) {
      throw new ImageError("jpeg-progressive", "This JPEG is progressive, save the skin as PNG");
    } else if (marker === 0xda) {
      if (components.length === 0) {
        throw new ImageError("broken-jpeg", "The JPEG image has no frame header");
      }
      const count = segment[0]!;
      const scanComponents: Component[] = [];
      for (let i = 0; i < count; i++) {
        const id = segment[1 + i * 2]!;
        const tables = segment[2 + i * 2]!;
        const component = components.find((item) => item.id === id);
        if (!component) {
          throw new ImageError("broken-jpeg", "The JPEG scan refers to a missing component");
        }
        component.dcTable = tables >> 4;
        component.acTable = tables & 15;
        scanComponents.push(component);
      }
      offset = decodeScan(scanComponents, offset + 2 + length);
      sawScan = true;
      continue;
    }
    offset += 2 + length;
  }

  if (!sawScan || components.length === 0) {
    throw new ImageError("broken-jpeg", "The JPEG image has no picture data");
  }

  const block = new Int32Array(64);
  for (const component of components) {
    const quant = quantTables[component.quantTable];
    if (!quant) {
      throw new ImageError("broken-jpeg", "The JPEG image refers to a missing table");
    }
    const stride = component.blocksPerLine * 8;
    for (let row = 0; row < component.blocksPerColumn; row++) {
      for (let column = 0; column < component.blocksPerLine; column++) {
        const source = (row * component.blocksPerLine + column) * 64;
        for (let i = 0; i < 64; i++) {
          block[i] = component.coefficients[source + i]! * quant[i]!;
        }
        idct(block, component.samples, row * 8 * stride + column * 8, stride);
      }
    }
  }

  const data = Buffer.alloc(size.width * size.height * 4);
  const [y, cb, cr] = components;
  for (let row = 0; row < size.height; row++) {
    for (let column = 0; column < size.width; column++) {
      const target = (row * size.width + column) * 4;
      const sample = (component: Component): number => {
        const stride = component.blocksPerLine * 8;
        const sx = Math.min(stride - 1, Math.floor((column * component.h) / maxH));
        const sy = Math.min(component.blocksPerColumn * 8 - 1, Math.floor((row * component.v) / maxV));
        return component.samples[sy * stride + sx]!;
      };
      if (components.length === 1) {
        const gray = sample(y!);
        data[target] = gray;
        data[target + 1] = gray;
        data[target + 2] = gray;
      } else {
        const luma = sample(y!);
        const blue = sample(cb!) - 128;
        const red = sample(cr!) - 128;
        const clamp = (value: number): number => (value < 0 ? 0 : value > 255 ? 255 : Math.round(value));
        data[target] = clamp(luma + 1.402 * red);
        data[target + 1] = clamp(luma - 0.344136 * blue - 0.714136 * red);
        data[target + 2] = clamp(luma + 1.772 * blue);
      }
      // JPEG has no transparency, a converted skin is fully opaque
      data[target + 3] = 255;
    }
  }

  return { width: size.width, height: size.height, data };
}
