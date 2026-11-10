import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CITY } from '../cities.ts';
import { askJson } from '../claude.ts';
import { encodeForModel, MAX_PHOTOS } from '../photos.ts';
import type { Listing } from '../sources/types.ts';
import { PhotoResultSchema, TextResultSchema, type PhotoResult, type TextResult } from './schemas.ts';

const ROOT = new URL('../../', import.meta.url);
// Читаємо щоразу, щоб правки criteria.md/промптів діяли без перезапуску
const read = (rel: string) => readFileSync(new URL(rel, ROOT), 'utf-8');

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key: string) => vars[key] ?? m);
}

/** criteria.md з підставленим містом ({{city}}). */
// criteria.md — особистий файл (у .gitignore); якщо його ще не створили, береться приклад із репозиторію.
const criteriaFile = () => (existsSync(new URL('criteria.md', ROOT)) ? 'criteria.md' : 'criteria.example.md');
const criteria = (city: string) => fillTemplate(read(criteriaFile()).trim(), { city });

export interface PriceChange {
  from: number | null;
  to: number | null;
}

export function buildTextPrompt(l: Listing, priceChange?: PriceChange, city: string = DEFAULT_CITY.name): string {
  return fillTemplate(read('prompts/text.md'), {
    city,
    criteria: criteria(city),
    source: l.source,
    url: l.url,
    title: l.title,
    price: l.priceText || 'не вказано',
    location: l.location,
    date: l.date ?? 'невідомо',
    photo_count: String(l.photoUrls.length),
    price_note: priceChange ? `Note: the price changed from ${priceChange.from ?? '?'} € to ${priceChange.to ?? '?'} €.` : '',
    description: l.description,
  });
}

type Log = (msg: string) => void;

// Текстовий аналіз завжди на sonnet; CLAUDE_MODEL/--model стосуються лише фото (там haiku за замовчуванням).
// Без «роздумів»: на замірах утричі дешевше і вп'ятеро швидше, ніж effort high з роздумами. Замість роздумів модель
// заповнює must_have (перевірка кожної обов'язкової вимоги) перед вердиктом. Effort без роздумів на вартість
// не впливає (заміри low/high/max однакові) — тому max.
const TEXT_MODEL = 'sonnet';
const TEXT_EFFORT = 'max';

export async function analyzeText(l: Listing, priceChange: PriceChange | undefined, city: string, log?: Log): Promise<TextResult> {
  const result = await askJson(buildTextPrompt(l, priceChange, city), TextResultSchema, {
    model: TEXT_MODEL, effort: TEXT_EFFORT, thinking: false, timeoutMs: 180_000, tag: 'текст', log,
  });
  return enforceMustHave(result);
}

/** Якщо модель сама позначила обов'язкову вимогу як невиконану, а вердикт дала інший — вердикт `no`. */
export function enforceMustHave(r: TextResult): TextResult {
  const failed = (r.must_have ?? []).filter((m) => m.met === false);
  if (!failed.length || r.verdict === 'no') return r;
  return {
    ...r,
    verdict: 'no',
    red_flags: [...failed.map((m) => `Не виконано: ${m.requirement} — ${m.evidence}`), ...r.red_flags],
  };
}

/** Усі фото оголошення йдуть прямо в повідомленні (зменшені до 768 px), без інструментів — один хід. */
export async function analyzePhotos(l: Listing, text: TextResult, photoDir: string, files: string[], model: string, city: string, log?: Log): Promise<PhotoResult> {
  const used = files.slice(0, MAX_PHOTOS);
  const prompt = fillTemplate(read('prompts/photos.md'), {
    city,
    photo_count: String(used.length),
    listing_summary: `${l.title}\n${text.summary_uk}`,
    criteria: criteria(city),
  });
  const images = await Promise.all(used.map((f) => encodeForModel(join(photoDir, f))));
  return askJson(prompt, PhotoResultSchema, { model, images, timeoutMs: 600_000, tag: `фото (${used.length} шт.)`, log });
}
