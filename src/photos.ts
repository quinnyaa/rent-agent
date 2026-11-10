import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { fetchBuffer } from './http.ts';

// Беремо всі фото оголошення: модель має бачити кожну кімнату, інакше пише «ванна не показана», хоча вона на фото 7+.
// 20 — стеля каруселі bazos і запобіжник від аномально довгих списків.
export const MAX_PHOTOS = 20;
// На диску (і в Telegram) — 1024 px; моделі — 768 px: ~490 токенів на фото замість ~870
const MAX_SIDE = 1024;
const MODEL_SIDE = 768;
// Стеля розміру вхідного фото для sharp (типова — 268 Мп): фото з телефона — до ~50 Мп, більше — аномалія
const MAX_INPUT_PIXELS = 60_000_000;

export function photoDir(dataDir: string, source: string, id: string) {
  return join(dataDir, 'photos', `${source}-${id}`);
}

/**
 * Завантажує всі фото (не більше MAX_PHOTOS), стискає до 1024 px по більшій стороні.
 * Повертає імена файлів у порядку оголошення (01.jpg, 02.jpg…).
 */
export async function downloadPhotos(urls: string[], dir: string): Promise<string[]> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const [i, url] of urls.slice(0, MAX_PHOTOS).entries()) {
    const name = `${String(i + 1).padStart(2, '0')}.jpg`;
    try {
      const jpeg = await sharp(await fetchBuffer(url), { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      writeFileSync(join(dir, name), jpeg);
      files.push(name);
    } catch (err) {
      console.warn(`  фото ${url} пропущено: ${(err as Error).message}`);
    }
  }
  return files;
}

/** Фото для моделі: зменшене до 768 px, JPEG у base64. */
export async function encodeForModel(path: string): Promise<string> {
  const jpeg = await sharp(path, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize(MODEL_SIDE, MODEL_SIDE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return jpeg.toString('base64');
}

export function listPhotos(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
  } catch {
    return [];
  }
}
