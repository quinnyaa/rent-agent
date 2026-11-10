import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_CITY } from './cities.ts';
import type { Listing, ListingSummary } from './sources/types.ts';

/**
 * Статуси:
 *  new              — знайдено, ще не оброблено (або ціна змінилась → обробити знову)
 *  pending_analysis — помилка/ліміт Claude чи сайту, повтор наступного запуску
 *  rejected         — не підходить (причина в reject_reason)
 *  matched          — підходить, ще не надіслано (dry-run або помилка Telegram)
 *  notified         — надіслано в Telegram
 *  skipped_initial  — не оброблялось при першому запуску (поза FIRST_RUN_LIMIT)
 *  gone             — застарілий: видалені оголошення тепер прибираються з БД (Db.remove), статус лишено для сумісності
 */
export type Status = 'new' | 'pending_analysis' | 'rejected' | 'matched' | 'notified' | 'skipped_initial' | 'gone';

export interface ListingRow {
  source: string;
  id: string;
  /** Місто пошуку (City.name), у якому знайдено оголошення. */
  city: string;
  url: string;
  title: string;
  price: number | null;
  price_text: string;
  price_prev: number | null;
  price_changed: number;
  location: string;
  posted_date: string | null;
  raw_text: string | null;
  photos_json: string | null;
  first_seen: string;
  last_seen: string;
  status: Status;
  reject_reason: string | null;
  error: string | null;
  attempts: number;
  text_result_json: string | null;
  photo_result_json: string | null;
  notified_at: string | null;
}

const now = () => new Date().toISOString();

export class Db {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS listings (
        source TEXT NOT NULL,
        id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        price REAL,
        price_text TEXT NOT NULL DEFAULT '',
        price_prev REAL,
        price_changed INTEGER NOT NULL DEFAULT 0,
        location TEXT NOT NULL DEFAULT '',
        posted_date TEXT,
        raw_text TEXT,
        photos_json TEXT,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        status TEXT NOT NULL,
        reject_reason TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        text_result_json TEXT,
        photo_result_json TEXT,
        notified_at TEXT,
        city TEXT NOT NULL DEFAULT 'Poprad',
        PRIMARY KEY (source, id)
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        seen INTEGER NOT NULL DEFAULT 0,
        new_count INTEGER NOT NULL DEFAULT 0,
        matched INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        city TEXT NOT NULL DEFAULT 'Poprad'
      );
    `);
    // Міграція: колонка city з'явилась пізніше — старі записи (усі з Попраду) отримують default
    // (SwiftBar і heartbeat рахують запуски лише свого міста — тому city є і в runs)
    for (const table of ['listings', 'runs']) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === 'city')) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN city TEXT NOT NULL DEFAULT '${DEFAULT_CITY.name}'`);
      }
    }
  }

  /** Чи ще не було жодного оголошення з цього джерела (у цьому місті, якщо задано). */
  isEmpty(source: string, city?: string): boolean {
    const row = (city === undefined
      ? this.db.prepare('SELECT COUNT(*) AS n FROM listings WHERE source = ?').get(source)
      : this.db.prepare('SELECT COUNT(*) AS n FROM listings WHERE source = ? AND city = ?').get(source, city)) as { n: number };
    return row.n === 0;
  }

  get(source: string, id: string): ListingRow | undefined {
    return this.db.prepare('SELECT * FROM listings WHERE source = ? AND id = ?').get(source, id) as
      | ListingRow
      | undefined;
  }

  insertSummary(s: ListingSummary, status: Status, city: string = DEFAULT_CITY.name) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO listings (source, id, city, url, title, price, price_text, location, posted_date, first_seen, last_seen, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.source, s.id, city, s.url, s.title, s.price, s.priceText, s.location, s.date, ts, ts, status);
  }

  /** Оновлює last_seen; якщо ціна змінилась — повертає оголошення в обробку. */
  touch(s: ListingSummary, row: ListingRow): { priceChanged: boolean } {
    const priceChanged = row.price_text !== s.priceText;
    if (priceChanged) {
      this.db
        .prepare(
          `UPDATE listings SET last_seen = ?, title = ?, posted_date = ?, price_prev = price, price = ?, price_text = ?,
             price_changed = 1, status = 'new', attempts = 0, error = NULL
           WHERE source = ? AND id = ?`,
        )
        .run(now(), s.title, s.date, s.price, s.priceText, s.source, s.id);
    } else {
      this.db
        .prepare('UPDATE listings SET last_seen = ?, title = ?, posted_date = ? WHERE source = ? AND id = ?')
        .run(now(), s.title, s.date, s.source, s.id);
    }
    return { priceChanged };
  }

  saveDetails(l: Listing) {
    this.db
      .prepare(
        `UPDATE listings SET title = ?, price = ?, price_text = ?, location = ?, posted_date = ?, raw_text = ?, photos_json = ?
         WHERE source = ? AND id = ?`,
      )
      .run(l.title, l.price, l.priceText, l.location, l.date, l.description, JSON.stringify(l.photoUrls), l.source, l.id);
  }

  saveTextResult(source: string, id: string, result: unknown) {
    this.db
      .prepare('UPDATE listings SET text_result_json = ? WHERE source = ? AND id = ?')
      .run(JSON.stringify(result), source, id);
  }

  savePhotoResult(source: string, id: string, result: unknown) {
    this.db
      .prepare('UPDATE listings SET photo_result_json = ? WHERE source = ? AND id = ?')
      .run(result === null ? null : JSON.stringify(result), source, id);
  }

  setStatus(source: string, id: string, status: Status, extra: { reason?: string; error?: string; countAttempt?: boolean } = {}) {
    this.db
      .prepare(
        `UPDATE listings SET status = ?, reject_reason = ?, error = ?,
           attempts = attempts + ?
         WHERE source = ? AND id = ?`,
      )
      .run(status, extra.reason ?? null, extra.error ?? null, status === 'pending_analysis' && extra.countAttempt !== false ? 1 : 0, source, id);
  }

  /** Видаляє оголошення з БД (сторінка більше не відкривається). Фото на диску прибирає викликач. */
  remove(source: string, id: string) {
    this.db.prepare(`DELETE FROM listings WHERE source = ? AND id = ?`).run(source, id);
  }

  markNotified(source: string, id: string) {
    this.db
      .prepare(`UPDATE listings SET status = 'notified', notified_at = ?, price_changed = 0 WHERE source = ? AND id = ?`)
      .run(now(), source, id);
  }

  /** Підхожі, але ще не надіслані (після dry-run або збою Telegram) — лише з указаного міста. */
  unsentMatches(city: string = DEFAULT_CITY.name): ListingRow[] {
    return this.db
      .prepare(`SELECT * FROM listings WHERE status = 'matched' AND notified_at IS NULL AND city = ? ORDER BY first_seen`)
      .all(city) as unknown as ListingRow[];
  }

  /** Підхожі оголошення, які ще є в пошуку (бачили після вказаного моменту). */
  activeMatches(seenSinceIso: string, city: string = DEFAULT_CITY.name): ListingRow[] {
    return this.db
      .prepare(
        `SELECT * FROM listings WHERE status IN ('matched', 'notified') AND last_seen >= ? AND city = ?
           AND text_result_json IS NOT NULL AND photo_result_json IS NOT NULL`,
      )
      .all(seenSinceIso, city) as unknown as ListingRow[];
  }

  /** Оголошення зі збереженим описом і текстовою оцінкою — для доаналізу (backfill-extras). */
  analyzedWithText(): ListingRow[] {
    return this.db
      .prepare(`SELECT * FROM listings WHERE raw_text IS NOT NULL AND raw_text != '' AND text_result_json IS NOT NULL ORDER BY first_seen`)
      .all() as unknown as ListingRow[];
  }

  /** Оголошення, які вичерпали спроби аналізу і більше не беруться в чергу. */
  stuckCount(city: string, maxAttempts: number): number {
    const row = this.db
      .prepare(`SELECT count(*) AS n FROM listings WHERE city = ? AND status IN ('new', 'pending_analysis') AND attempts >= ?`)
      .get(city, maxAttempts) as { n: number };
    return row.n;
  }

  /** Оголошення міста, яких не було в пошуку з моменту `sinceIso` (для звірки --sync). */
  notSeenSince(sinceIso: string, city: string = DEFAULT_CITY.name): ListingRow[] {
    return this.db
      .prepare('SELECT * FROM listings WHERE city = ? AND last_seen < ? ORDER BY last_seen')
      .all(city, sinceIso) as unknown as ListingRow[];
  }

  getMeta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  startRun(city: string = DEFAULT_CITY.name): number {
    return Number(this.db.prepare('INSERT INTO runs (started_at, city) VALUES (?, ?)').run(now(), city).lastInsertRowid);
  }

  finishRun(runId: number, stats: { seen: number; newCount: number; matched: number; error?: string }) {
    this.db
      .prepare('UPDATE runs SET finished_at = ?, seen = ?, new_count = ?, matched = ?, error = ? WHERE id = ?')
      .run(now(), stats.seen, stats.newCount, stats.matched, stats.error ?? null, runId);
  }

  /** Статистика запусків міста після вказаного моменту — для heartbeat. */
  runStatsSince(sinceIso: string, city: string = DEFAULT_CITY.name) {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS runs, COALESCE(MAX(seen), 0) AS seen, COALESCE(SUM(new_count), 0) AS new_count,
           COALESCE(SUM(matched), 0) AS matched, SUM(error IS NOT NULL) AS errors
         FROM runs WHERE started_at >= ? AND city = ?`,
      )
      .get(sinceIso, city) as { runs: number; seen: number; new_count: number; matched: number; errors: number };
  }

  close() {
    this.db.close();
  }
}
