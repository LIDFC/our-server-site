import { ImageError, type RgbaImage } from "./png.ts";

/**
 * The face out of a Minecraft skin, as a square picture.
 *
 * <p>A skin file is a texture atlas, and the head is always in the same two places: the face at (8,8) and the hat
 * layer over it at (40,8), both 8×8. That holds for the old 64×32 layout and the modern 64×64 one alike, which is why
 * this works on every skin the site accepts.
 *
 * <p>Scaling is whole-number nearest neighbour on purpose. A face is 8 pixels across; smoothing it would turn the
 * thing people recognise into a smudge.
 */

const FACE_X = 8;
const FACE_Y = 8;
const HAT_X = 40;
const HAT_Y = 8;
const SIZE = 8;

function pixel(image: RgbaImage, x: number, y: number): [number, number, number, number] {
  const at = (y * image.width + x) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0, image.data[at + 3] ?? 0];
}

/**
 * Renders the head at `scale` times its 8×8 size. The hat layer is drawn over the face where it is not transparent,
 * so hair, helmets and glasses come out the way their owner drew them.
 */
export function renderHead(skin: RgbaImage, scale: number): RgbaImage {
  if (skin.width < HAT_X + SIZE || skin.height < FACE_Y + SIZE) {
    throw new ImageError("bad-size", "This skin is too small to have a head in it");
  }
  const step = Math.max(1, Math.floor(scale));
  const size = SIZE * step;
  const data = Buffer.alloc(size * size * 4);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let [r, g, b, a] = pixel(skin, FACE_X + x, FACE_Y + y);
      const [hr, hg, hb, ha] = pixel(skin, HAT_X + x, HAT_Y + y);
      if (ha > 0) {
        // the hat is drawn over the face; a partly transparent hat is blended, which is what the game does too
        const alpha = ha / 255;
        r = Math.round(hr * alpha + r * (1 - alpha));
        g = Math.round(hg * alpha + g * (1 - alpha));
        b = Math.round(hb * alpha + b * (1 - alpha));
        a = Math.max(a, ha);
      }
      // a fully transparent face pixel would be a hole in a head, so it is filled rather than left see through
      if (a === 0) {
        [r, g, b, a] = [60, 60, 66, 255];
      }
      for (let dy = 0; dy < step; dy++) {
        for (let dx = 0; dx < step; dx++) {
          const at = ((y * step + dy) * size + (x * step + dx)) * 4;
          data[at] = r;
          data[at + 1] = g;
          data[at + 2] = b;
          data[at + 3] = 255;
        }
      }
    }
  }
  return { width: size, height: size, data };
}
