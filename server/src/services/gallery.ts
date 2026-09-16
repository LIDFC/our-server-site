import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const GALLERY_FILE = "gallery.json";
export const IMAGE_FILE = /^[a-z0-9][a-z0-9._-]{0,99}\.(webp|avif|jpg|jpeg|png)$/i;
const WORLD_LIMIT = 30_000_000;

export interface GalleryItem {
  id: string;
  title: string;
  author: string;
  description: string;
  imageUrl: string;
  coords: { x: number; y: number; z: number };
  addedAt: string | null;
}

/** Where gallery entries come from. The file store is the first implementation, an admin panel can bring another one. */
export interface GalleryStore {
  list(): Promise<GalleryItem[]>;
  imagePath(fileName: string): string | null;
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function coordinate(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** Validates the raw entries, invalid ones are reported and skipped instead of breaking the whole gallery. */
export function parseGallery(json: unknown, imageExists: (fileName: string) => boolean): { items: GalleryItem[]; problems: string[] } {
  const items: GalleryItem[] = [];
  const problems: string[] = [];
  const entries = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(entries)) {
    return { items, problems: ["gallery.json must contain an \"items\" array"] };
  }

  entries.forEach((entry, index) => {
    const raw = (entry ?? {}) as Record<string, unknown>;
    const coords = (raw.coords ?? {}) as Record<string, unknown>;
    const id = typeof raw.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.id) ? raw.id : null;
    const title = text(raw.title, 80);
    const author = text(raw.author, 32);
    const description = raw.description === undefined ? "" : text(raw.description, 400);
    const image = typeof raw.image === "string" && IMAGE_FILE.test(raw.image) ? raw.image : null;
    const x = coordinate(coords.x, -WORLD_LIMIT, WORLD_LIMIT);
    const y = coordinate(coords.y, -64, 320);
    const z = coordinate(coords.z, -WORLD_LIMIT, WORLD_LIMIT);
    const addedAt = typeof raw.addedAt === "string" && !Number.isNaN(Date.parse(raw.addedAt)) ? raw.addedAt : null;

    const label = `item ${index + 1}${id ? ` (${id})` : ""}`;
    if (!id || !title || !author || description === null || !image || x === null || y === null || z === null) {
      problems.push(`${label}: id, title, author, image and integer coords x/y/z are required, description is optional`);
      return;
    }
    if (items.some((item) => item.id === id)) {
      problems.push(`${label}: the id is used twice`);
      return;
    }
    if (!imageExists(image)) {
      problems.push(`${label}: images/${image} does not exist`);
      return;
    }
    items.push({ id, title, author, description, imageUrl: `/media/gallery/${image}`, coords: { x, y, z }, addedAt });
  });

  return { items, problems };
}

export function createFileGalleryStore(galleryDir: string): GalleryStore {
  const imagesDir = path.join(galleryDir, "images");
  const filePath = path.join(galleryDir, GALLERY_FILE);
  let cached: { mtimeMs: number; items: GalleryItem[] } | null = null;

  return {
    async list() {
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(filePath)).mtimeMs;
      } catch {
        return [];
      }
      // the file is only parsed again after it changed
      if (cached?.mtimeMs === mtimeMs) {
        return cached.items;
      }
      let json: unknown = null;
      try {
        json = JSON.parse(await readFile(filePath, "utf8"));
      } catch (error) {
        console.warn(`[gallery] ${GALLERY_FILE} is not valid JSON: ${error}`);
      }
      const existing = new Set<string>();
      if (json) {
        for (const item of ((json as { items?: unknown }).items as { image?: unknown }[] | undefined) ?? []) {
          if (typeof item?.image === "string" && IMAGE_FILE.test(item.image)) {
            try {
              if ((await stat(path.join(imagesDir, item.image))).isFile()) {
                existing.add(item.image);
              }
            } catch {
              // reported by parseGallery
            }
          }
        }
      }
      const { items, problems } = parseGallery(json, (fileName) => existing.has(fileName));
      for (const problem of problems) {
        console.warn(`[gallery] ${problem}`);
      }
      cached = { mtimeMs, items };
      return items;
    },

    imagePath(fileName) {
      return IMAGE_FILE.test(fileName) ? path.join(imagesDir, fileName) : null;
    },
  };
}
