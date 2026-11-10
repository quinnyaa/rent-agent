import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from './http.ts';
import type { PhotoResult, TextResult } from './analyze/schemas.ts';
import type { ListingRow } from './db.ts';

const CAPTION_LIMIT = 1024;
const NETWORK_RETRIES = 3;

export interface Notifier {
  sendListing(caption: string, photoPaths: string[]): Promise<void>;
  /** html: true — parse_mode HTML (текст має бути екранований через escapeHtml). */
  sendMessage(text: string, opts?: { html?: boolean }): Promise<void>;
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+([.,]\d+)?$/.test(v.trim())) return Number(v.replace(',', '.'));
  return null;
};
const short = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function priceLine(row: ListingRow, ex: TextResult['extracted']): string {
  const rent = num(ex.rent_eur) ?? row.price;
  const energies = num(ex.energies_eur);
  const total = num(ex.total_monthly_eur);
  if (rent === null) return row.price_text || 'ціна ?';
  if (energies === 0) return `${rent} € з енергіями`;
  if (energies !== null) return `${rent} € + ${energies} € = ${total ?? rent + energies} €`;
  if (total !== null && total !== rent) return `${rent} € → разом ${total} €`;
  if (total === rent) return `${rent} € з енергіями`;
  return `${rent} € + енергії ?`;
}

type Extracted = TextResult['extracted'];
const NA = 'не вказано';

/** true / false / null з того, що повернула модель (буває рядок замість boolean). */
const bool = (v: unknown): boolean | null => {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return null;
  if (/^(true|yes|так|є|áno|ano)$/i.test(v.trim())) return true;
  if (/^(false|no|ні|немає|nie)$/i.test(v.trim())) return false;
  return null;
};
const str = (v: unknown, n = 60): string | null => {
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && !/^(null|n\/a|не вказано)$/i.test(t) ? short(t, n) : null;
};
const yesNo = (v: unknown) => ({ true: 'є', false: 'немає', null: NA })[String(bool(v)) as 'true' | 'false' | 'null'];
const FURNISHED: Record<string, string> = { yes: 'повністю', partly: 'частково', no: 'без меблів' };
const LANDLORD: Record<string, string> = { owner: 'власник', agency: 'агенція' };

type Seen = PhotoResult['seen'];
type SeenKey = keyof NonNullable<Seen>;
/** Текст про це мовчить (null), але на фото чітко видно. Якщо текст каже так/ні — вірити тексту. */
const seenOnly = (ex: Extracted, seen: Seen, key: SeenKey): boolean => bool(ex[key]) === null && bool(seen?.[key]) === true;
/** Є за текстом або видно на фото. */
const has = (ex: Extracted, seen: Seen, key: SeenKey): boolean => bool(ex[key]) === true || seenOnly(ex, seen, key);
const yesNoSeen = (ex: Extracted, seen: Seen, key: SeenKey) => (seenOnly(ex, seen, key) ? 'є (на фото)' : yesNo(ex[key]));

/** Посудомийка згадана в тексті або видна на фото. */
export const hasDishwasher = (ex: Extracted, seen?: Seen): boolean => has(ex, seen, 'dishwasher');
/** Підлогове опалення згадане в тексті. */
export const hasFloorHeating = (ex: Extracted): boolean => bool(ex.floor_heating) === true;

/**
 * Структурований блок фактів для підпису. Основні пункти показуються завжди («не вказано», якщо в тексті немає;
 * посудомийка, пральна, кондиціонер і балкон — «є (на фото)», якщо текст мовчить, а на фото видно),
 * другорядні (тварини, заїзд, хто здає) — лише коли відомі.
 */
export function factLines(row: ListingRow, ex: Extracted, seen?: Seen): string[] {
  const rooms = num(ex.rooms);
  const area = num(ex.area_m2);
  const title = [rooms !== null ? `${rooms}-кімн.` : short(row.title, 60), area !== null ? `${area} м²` : null, str(ex.district_or_street, 70)]
    .filter(Boolean)
    .join(' · ');
  const deposit = num(ex.deposit_eur);
  const floor = str(ex.floor, 20);
  const elevator = bool(ex.elevator);
  const floorLine = [floor ?? NA, elevator === true ? 'ліфт є' : elevator === false ? 'без ліфта' : null].filter(Boolean).join(', ');
  const furnished = str(ex.furnished);
  const moveIn = [str(ex.available_from, 30), str(ex.min_term, 30) && `термін: ${str(ex.min_term, 30)}`]
    .filter(Boolean)
    .join(' · ');
  const pets = str(ex.pets);
  const landlord = str(ex.landlord_type);
  // «16.10. 2026» з bazos → «16.10.2026»
  const posted = row.posted_date?.replace(/\s+/g, '') || null;

  return [
    `🏠 ${title}`,
    posted ? `🗓 На сайті з ${posted}` : null,
    `💶 ${priceLine(row, ex)}`,
    `💰 Застава: ${deposit !== null ? `${deposit} €` : NA}`,
    `🔥 Опалення: ${str(ex.heating) ?? NA}`,
    `♨️ Підлогове опалення: ${yesNo(ex.floor_heating)}`,
    `🍽 Посудомийка: ${yesNoSeen(ex, seen, 'dishwasher')}`,
    `🧺 Пральна машина: ${yesNoSeen(ex, seen, 'washing_machine')}`,
    `🛋 Меблі: ${(furnished && FURNISHED[furnished]) ?? furnished ?? NA}`,
    `❄️ Кондиціонер: ${yesNoSeen(ex, seen, 'air_conditioning')}`,
    `🌿 Балкон: ${yesNoSeen(ex, seen, 'balcony')}`,
    `🏢 Поверх: ${floorLine}`,
    `🚗 Паркування: ${str(ex.parking) ?? NA}`,
    pets ? `🐾 Тварини: ${pets}` : null,
    moveIn ? `📅 Заїзд: ${moveIn}` : null,
    landlord ? `👤 Здає: ${LANDLORD[landlord] ?? landlord}` : null,
  ].filter((l): l is string => l !== null);
}

export function buildCaption(row: ListingRow, text: TextResult, photo: PhotoResult): string {
  const facts = factLines(row, text.extracted, photo.seen).join('\n');

  const pros = text.reasons.slice(0, 3).map((r) => short(r, 90));
  const cons = [...text.red_flags, ...photo.red_flags].slice(0, 3).map((r) => short(r, 90));

  let scores = `⭐ Текст ${text.score}/10 · Фото ${photo.score}/10`;
  if (row.price_changed && row.price_prev !== null && row.price !== null && row.price < row.price_prev) {
    scores += ` · 🔻 ${row.price_prev} → ${row.price} €`;
  }

  const list = (icon: string, items: string[]) => (items.length ? items.map((i) => `${icon} ${i}`).join('\n') : null);
  const build = (withSummary: boolean, items: number) =>
    [
      facts,
      withSummary ? `📝 ${text.summary_uk}` : null,
      [list('✅', pros.slice(0, items)), list('⚠️', cons.slice(0, items))].filter(Boolean).join('\n') || null,
      scores,
      row.url,
    ]
      .filter(Boolean)
      .join('\n\n');

  // Факти лишаються завжди; скорочуємо опис і плюси/мінуси, доки не вліземо в ліміт підпису
  for (const [withSummary, items] of [[true, 3], [false, 3], [false, 2], [false, 1], [false, 0]] as const) {
    const c = build(withSummary, items);
    if (c.length <= CAPTION_LIMIT) return c;
  }
  return `${short(facts, CAPTION_LIMIT - row.url.length - 2)}\n\n${row.url}`;
}

/** Номери найкращих фото від Claude → шляхи до файлів (до 5 шт.). */
export function pickPhotos(dir: string, files: string[], best: number[] | undefined): string[] {
  const chosen = (best ?? []).filter((n) => n >= 1 && n <= files.length).map((n) => files[n - 1]);
  const unique = [...new Set([...chosen, ...files])].slice(0, 5);
  return unique.map((f) => join(dir, f));
}

export class TelegramNotifier implements Notifier {
  constructor(private token: string, private chatId: string) {}

  private async call(method: string, body: FormData | Record<string, unknown>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const isForm = body instanceof FormData;
      let res: Response;
      try {
        res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: 'POST',
          body: isForm ? body : JSON.stringify(body),
          headers: isForm ? undefined : { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        // Мережа ще не піднялась (напр., після сну Mac) — чекаємо й пробуємо знову
        if (attempt < NETWORK_RETRIES) {
          await sleep(attempt * 10_000);
          continue;
        }
        throw err;
      }
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; parameters?: { retry_after?: number } };
      if (json.ok) return;
      if (res.status === 429 && attempt < 3) {
        await sleep(((json.parameters?.retry_after ?? 5) + 1) * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < NETWORK_RETRIES) {
        await sleep(attempt * 10_000);
        continue;
      }
      throw new Error(`Telegram ${method}: ${res.status} ${json.description ?? ''}`);
    }
  }

  async sendListing(caption: string, photoPaths: string[]) {
    const form = new FormData();
    form.append('chat_id', this.chatId);
    const media = photoPaths.map((p, i) => {
      form.append(`p${i}`, new Blob([readFileSync(p)], { type: 'image/jpeg' }), `p${i}.jpg`);
      return { type: 'photo', media: `attach://p${i}`, ...(i === 0 ? { caption } : {}) };
    });
    form.append('media', JSON.stringify(media));
    await this.call('sendMediaGroup', form);
  }

  async sendMessage(text: string, opts: { html?: boolean } = {}) {
    await this.call('sendMessage', {
      chat_id: this.chatId, text, disable_web_page_preview: true, ...(opts.html ? { parse_mode: 'HTML' } : {}),
    });
  }
}

/** --dry-run: усе в консоль. */
export class ConsoleNotifier implements Notifier {
  async sendListing(caption: string, photoPaths: string[]) {
    console.log(`\n──── [dry-run] Telegram ────\n${caption}\nФото: ${photoPaths.join(', ')}\n────────────────────────────\n`);
  }
  async sendMessage(text: string, _opts?: { html?: boolean }) {
    console.log(`\n──── [dry-run] Telegram ────\n${text}\n────────────────────────────\n`);
  }
}

export interface RankedListing {
  row: ListingRow;
  text: TextResult;
  photo: PhotoResult;
}

/** Відповідність вимогам без ціни; для старих записів без fit_score — звичайна оцінка тексту. */
const fit = (t: TextResult) => t.fit_score ?? t.score;

/** Посудомийка бажана, але не обов'язкова: +2 до суми «вимоги + фото» (діапазон 2–24 з усіма бонусами). */
export const DISHWASHER_BONUS = 2;
/** Підлогове опалення — так само бажане: +2. */
export const FLOOR_HEATING_BONUS = 2;

/** Бал для топу: відповідність вимогам (без ціни) + фото + бонуси за посудомийку і підлогове опалення. */
export const topScore = ({ text, photo }: RankedListing) =>
  fit(text) + photo.score + (hasDishwasher(text.extracted, photo.seen) ? DISHWASHER_BONUS : 0) +
  (hasFloorHeating(text.extracted) ? FLOOR_HEATING_BONUS : 0);

export function rankTop(items: RankedListing[], n: number): RankedListing[] {
  return [...items]
    .sort((a, b) => topScore(b) - topScore(a) || b.photo.score - a.photo.score || b.text.score - a.text.score)
    .slice(0, n);
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Ціна за місяць коротко: «690 €», «550 € + енергії ?». */
function monthlyPrice(row: ListingRow, ex: Extracted): string {
  const rent = num(ex.rent_eur) ?? row.price;
  const energies = num(ex.energies_eur);
  const total = num(ex.total_monthly_eur) ?? (rent !== null && energies !== null ? rent + energies : null);
  if (total !== null) return `${total} €`;
  if (rent !== null) return `${rent} € + енергії ?`;
  return row.price_text || 'ціна ?';
}

const TOP_LEGEND = '♨️ підлогове · 🍽 посудомийка · 🧺 пральна · 🌿 балкон · 🚗 паркування · ⭐ вимоги/фото · NEW — вперше в топі';

/**
 * Топ у HTML (надсилати з html: true): заголовок — посилання, під ним ціна, меблі, значки наявного і оцінки.
 * seenIds — ключі `source:id` усіх, хто вже колись був у надісланому топі; кого там немає — NEW на початку рядка
 * (лише при першій появі в топі; не задано — без позначок).
 */
export const topKey = (row: ListingRow) => `${row.source}:${row.id}`;
export function formatTop(items: RankedListing[], seenIds?: Set<string>): string {
  if (items.length === 0) return '';
  const entries = items.map((item, i) => {
    const { row, text, photo } = item;
    const ex = text.extracted;
    const rooms = num(ex.rooms);
    const area = num(ex.area_m2);
    const title = [rooms !== null ? `${rooms}-кімн.` : short(row.title, 50), area !== null ? `${Math.round(area)} м²` : null, str(ex.district_or_street, 35)]
      .filter(Boolean)
      .join(' · ');
    const isNew = seenIds !== undefined && !seenIds.has(topKey(row));
    const cheaper = row.price_changed && row.price_prev !== null && row.price !== null && row.price < row.price_prev;
    const furnished = str(ex.furnished);
    const icons = [
      hasFloorHeating(ex) ? '♨️' : null,
      hasDishwasher(ex, photo.seen) ? '🍽' : null,
      has(ex, photo.seen, 'washing_machine') ? '🧺' : null,
      has(ex, photo.seen, 'balcony') ? '🌿' : null,
      str(ex.parking) ? '🚗' : null,
    ].filter(Boolean).join('');
    const details = [
      `<b>${escapeHtml(monthlyPrice(row, ex))}</b>${cheaper ? ` 🔻 було ${row.price_prev} €` : ''}`,
      `🛋 ${furnished ? (FURNISHED[furnished] ?? escapeHtml(furnished)) : 'меблі ?'}`,
      icons || null,
      `⭐ ${fit(text)}/${photo.score}`,
    ].filter(Boolean).join(' · ');
    return `${i + 1}. ${isNew ? '<b>NEW</b> ' : ''}<a href="${escapeHtml(row.url)}">${escapeHtml(title)}</a>\n      ${details}`;
  });
  return `🏆 <b>Топ-${items.length} зараз</b> (за вимогами і фото, без ціни)\n<i>${TOP_LEGEND}</i>\n\n${entries.join('\n\n')}`;
}
