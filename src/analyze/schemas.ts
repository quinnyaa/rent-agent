import { z } from 'zod';

// Значення, які модель може дати як число, рядок ("cca 50", "dohodou") або не знати (null)
const loose = z.union([z.number(), z.string(), z.boolean()]).nullable().optional();
const score = z.coerce.number().int().min(1).max(10);

export const TextResultSchema = z.object({
  // Коротка перевірка кожної вимоги з «Must have» ДО вердикту — дешева заміна «роздумам».
  // Опційно: у старих записах у БД цього поля немає
  must_have: z
    .array(z.object({ requirement: z.string(), met: z.boolean().nullable(), evidence: z.string() }))
    .optional(),
  verdict: z.enum(['yes', 'maybe', 'no']),
  score,
  // Відповідність вимогам без урахування ціни — для топу; у старих записах може не бути
  fit_score: score.optional(),
  reasons: z.array(z.string()),
  red_flags: z.array(z.string()),
  extracted: z.object({
    rooms: loose,
    area_m2: loose,
    rent_eur: loose,
    energies_eur: loose,
    total_monthly_eur: loose,
    deposit_eur: loose,
    heating: loose,
    air_conditioning: loose,
    // Посудомийка: true — згадана в тексті, false — текст прямо каже, що немає, null — не згадано.
    // У старих записах відсутня, поки не прогнано npm run backfill:extras
    dishwasher: loose,
    // Підлогове опалення — те саме правило true/false/null; у старих записах відсутнє до backfill:extras
    floor_heating: loose,
    // Нові поля для структурованого підпису; у старих записах їх немає
    washing_machine: loose,
    balcony: loose,
    parking: loose,
    furnished: loose,
    district_or_street: loose,
    floor: loose,
    elevator: loose,
    pets: loose,
    available_from: loose,
    min_term: loose,
    landlord_type: loose,
  }),
  summary_uk: z.string(),
});
export type TextResult = z.infer<typeof TextResultSchema>;

export const PhotoResultSchema = z.object({
  score,
  renovation: z.string(),
  kitchen: z.string(),
  bathroom: z.string(),
  windows: z.string(),
  light: z.string(),
  furniture: z.string(),
  red_flags: z.array(z.string()),
  photos_look_real: z.boolean(),
  summary_uk: z.string(),
  // Техніка й зручності, які чітко видно на фото: true — видно, null — не видно (false не буває: «немає на фото» ≠ «немає»).
  // Доповнює extracted з тексту, коли там null. У старих записах відсутнє
  seen: z
    .object({ dishwasher: loose, washing_machine: loose, air_conditioning: loose, balcony: loose })
    .optional(),
  // Номери (з 1) 4–5 найкращих фото для Telegram
  best_photos: z.array(z.coerce.number().int()).optional(),
});
export type PhotoResult = z.infer<typeof PhotoResultSchema>;
