/**
 * Разовий доаналіз: проганяє вже збережені описи (listings.raw_text) через haiku лише з питаннями про посудомийку,
 * підлогове опалення, пральну машину, балкон і паркування та дописує ці поля в extracted у text_result_json.
 * Вердикти, статуси й оцінки не змінюються. Нові оголошення отримують ці поля в звичайному аналізі (prompts/text.md).
 *
 *   npm run backfill:extras               # лише ті, де якогось із полів ще немає
 *   npm run backfill:extras -- --force    # переоцінити всі
 *   npm run backfill:extras -- --dry-run  # не записувати в БД
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { fillTemplate } from './analyze/index.ts';
import { askJson, ClaudeLimitError, claudeLimitHit } from './claude.ts';
import { Db } from './db.ts';
import { acquireLock } from './lock.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');

const { values: args } = parseArgs({
  options: { force: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false } },
});

const flag = z.boolean().nullable();
const Answer = z.object({ dishwasher: flag, floor_heating: flag, washing_machine: flag, balcony: flag, parking: z.string().nullable(), evidence: z.string() });
const FIELDS = ['dishwasher', 'floor_heating', 'washing_machine', 'balcony', 'parking'] as const;
const log = (msg: string) => console.log(`${new Date().toLocaleTimeString('uk-UA')} ${msg}`);

const release = acquireLock(join(DATA_DIR, 'run.lock'));
if (!release) {
  log('Інший запуск ще працює (data/run.lock) — спробуй пізніше');
  process.exit(1);
}

const db = new Db(join(DATA_DIR, 'rent.db'));
try {
  const rows = db.analyzedWithText().filter((r) => {
    const ex = JSON.parse(r.text_result_json!).extracted ?? {};
    return args.force || FIELDS.some((f) => !(f in ex));
  });
  log(`Оголошень для перевірки: ${rows.length}${args['dry-run'] ? ' (dry-run, без запису)' : ''}`);
  const template = readFileSync(join(ROOT, 'prompts/extras.md'), 'utf-8');

  const found: string[] = [];
  const foundFloor: string[] = [];
  let done = 0;
  await Promise.all(
    rows.map(async (r, i) => {
      if (claudeLimitHit()) return;
      const say = (m: string) => log(`[${i + 1}/${rows.length}] ${r.id} ${m}`);
      let answer: z.infer<typeof Answer>;
      try {
        answer = await askJson(fillTemplate(template, { city: r.city, title: r.title, description: r.raw_text! }), Answer, {
          model: 'haiku', effort: 'max', thinking: false, timeoutMs: 180_000, tag: 'доаналіз', log: say,
        });
      } catch (err) {
        say(err instanceof ClaudeLimitError ? '→ ліміт Claude, решту пропущено' : `→ помилка: ${(err as Error).message}`);
        return;
      }
      done++;
      const yn = (v: boolean | null) => (v === true ? 'є' : v === false ? 'немає' : '?');
      say(`посудомийка ${yn(answer.dishwasher)}, підлогове ${yn(answer.floor_heating)}, пральна ${yn(answer.washing_machine)}, балкон ${yn(answer.balcony)}, ` +
        `паркування ${answer.parking ?? '?'}${answer.evidence ? ` («${answer.evidence}»)` : ''}`);
      if (answer.dishwasher === true) found.push(`[${r.status}] ${r.title} — ${r.url}\n    «${answer.evidence}»`);
      if (answer.floor_heating === true) foundFloor.push(`[${r.status}] ${r.title} — ${r.url}\n    «${answer.evidence}»`);
      if (args['dry-run']) return;
      // Перечитуємо JSON безпосередньо перед записом і міняємо лише одне поле
      const fresh = db.get(r.source, r.id)!;
      const result = JSON.parse(fresh.text_result_json!);
      const { evidence: _, ...fields } = answer;
      result.extracted = { ...result.extracted, ...fields };
      db.saveTextResult(r.source, r.id, result);
    }),
  );

  log(`Перевірено ${done} з ${rows.length}; з посудомийкою: ${found.length}; з підлоговим опаленням: ${foundFloor.length}`);
  if (found.length) console.log(`\nПосудомийка:\n${found.join('\n')}`);
  if (foundFloor.length) console.log(`\nПідлогове опалення:\n${foundFloor.join('\n')}`);
} finally {
  db.close();
  release();
}
