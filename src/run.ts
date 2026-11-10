import 'dotenv/config';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { analyzePhotos, analyzeText, type PriceChange } from './analyze/index.ts';
import { PhotoResultSchema, TextResultSchema, type PhotoResult, type TextResult } from './analyze/schemas.ts';
import { getCity } from './cities.ts';
import { ClaudeAuthError, ClaudeLimitError, claudeAuthFailed, claudeLimitHit, claudeSucceeded } from './claude.ts';
import { AUTH_HINT, describeProblem, problemLines } from './problems.ts';
import { Db, type ListingRow } from './db.ts';
import { envInt, intSetting } from './env.ts';
import { HttpError } from './http.ts';
import { acquireLock } from './lock.ts';
import { downloadPhotos, listPhotos, MAX_PHOTOS, photoDir } from './photos.ts';import { appendShortlist } from './shortlist.ts';
import { sources } from './sources/index.ts';
import { syncGone, syncLine, type SyncResult } from './sync.ts';
import type { ListingSummary, SourceAdapter } from './sources/types.ts';
import { buildCaption, ConsoleNotifier, escapeHtml, formatTop, pickPhotos, rankTop, TelegramNotifier, topKey, type Notifier } from './telegram.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const SHORTLIST = join(ROOT, 'shortlist.md');
const MAX_ATTEMPTS = 5;
const ALERT_COOLDOWN_MS = 6 * 3600_000;

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    limit: { type: 'string' },
    model: { type: 'string' },
    city: { type: 'string' },
    digest: { type: 'boolean', default: false },
    recheck: { type: 'string' },
    sync: { type: 'boolean', default: false },
  },
});
const DRY_RUN = args['dry-run']!;
/**
 * Режим «лише підсумок»: підхожі не шлються в Telegram поштучно, а одразу позначаються notified (+ shortlist.md);
 * у Telegram іде тільки підсумок запуску з топ-10 (навіть якщо нового не знайдено). Heartbeat не шлеться.
 */
const DIGEST = args.digest!;
/**
 * `--recheck id1,id2`: ці оголошення з БД проганяються заново (сторінка, текст, фото — без кешу), навіть якщо їх уже
 * немає в пошуку чи вони давно оброблені. Якщо сторінка зникла — видаляються, як завжди.
 */
const RECHECK = new Set((args.recheck ?? '').split(',').map((s) => s.trim()).filter(Boolean));
/**
 * `--sync`: повна звірка БД із сайтом. Після звичайного прогону кожен запис міста, якого не було в пошуку,
 * перевіряється окремо (isAlive); ті, чия сторінка не відкривається, видаляються з БД разом із фото.
 */
const SYNC = args.sync!;
const LIMIT = intSetting('--limit', args.limit, Infinity, 0, Number.MAX_SAFE_INTEGER);
const MODEL = args.model ?? process.env.CLAUDE_MODEL ?? 'haiku';
/** Місто пошуку: фільтр bazos, {{city}} у промптах, listings.city. Топ і досилання — лише в межах міста. */
const CITY = getCity(args.city ?? process.env.CITY);
const PHOTO_SCORE_MIN = envInt('PHOTO_SCORE_MIN', 5, 1, 10);
const FIRST_RUN_LIMIT = envInt('FIRST_RUN_LIMIT', 40, 0, 100_000);
const HEARTBEAT_HOUR = envInt('HEARTBEAT_HOUR', 20, 0, 23);
const TOP_N = 10;
/** Скільки ключів пам'ятати в meta.top:seen (найстаріші витісняються). */
const TOP_SEEN_MAX = 2000;

const log = (msg: string) => console.log(`${new Date().toLocaleTimeString('uk-UA')} ${msg}`);

interface QueueItem {
  source: SourceAdapter;
  summary: ListingSummary;
  priceChange?: PriceChange;
  /** Примусова переоцінка (--recheck): не брати попередню оцінку фото з кешу. */
  force?: boolean;
}

class Runner {
  stats = { seen: 0, newCount: 0, matched: 0 };
  errors: string[] = [];
  pageErrors = 0;
  /** Причини, чому оголошення лишились необробленими (причина → кількість) — у підсумок Telegram. */
  problems = new Map<string, number>();
  /** Підхожі, які не вдалося надіслати в Telegram у цьому запуску. */
  telegramFailed = 0;
  // Підсумок запуску для Telegram
  outcomes = { processed: 0, priceChanged: 0, matched: 0, rejected: 0, pending: 0, gone: 0, skipped: 0 };

  readonly startedAt = new Date().toISOString();
  /** Оголошення, сторінку яких успішно відкрили в цьому запуску — для топу їх не перевіряємо вдруге. */
  private openedNow = new Set<string>();

  /** Усі, хто колись був у топі, разом із щойно сформованим — у meta.top:seen після успішної відправки. */
  private pendingTopSeen: string[] | null = null;

  /** Результат звірки (--sync) — рядок у підсумок Telegram. */
  private syncResult: SyncResult | null = null;

  constructor(private db: Db, private notifier: Notifier) {}

  /** --sync: записи міста, яких не було в цьому пошуку, перевіряємо по одному; зниклі видаляємо. */
  async sync() {
    if (this.stats.seen === 0) return log('звірка: пошук не вдався — пропускаю, щоб не видалити зайвого');
    const rows = this.db.notSeenSince(this.startedAt, CITY.name).filter((r) => !this.openedNow.has(`${r.source}:${r.id}`));
    log(`звірка: у БД ${rows.length} оголошень, яких немає в пошуку — перевіряю сторінки`);
    this.syncResult = await syncGone(rows, {
      isAlive: async (row) => sources.find((s) => s.name === row.source)?.isAlive(row.url) ?? null,
      remove: (row) => this.removeListing(row.source, row.id),
      dryRun: DRY_RUN,
      log,
    });
    log(syncLine(this.syncResult, DRY_RUN));
    if (!DRY_RUN) this.db.setMeta('sync:last', JSON.stringify({ at: new Date().toISOString(), ...this.syncResult }));
  }

  problem(reason: string) {
    this.problems.set(reason, (this.problems.get(reason) ?? 0) + 1);
  }

  /**
   * Топ-N серед підхожих, які зараз є в пошуку. Кожного кандидата перевіряємо, що сторінка ще відкривається;
   * видалені прибираємо з БД (removeListing) і беремо наступного з рейтингу, поки не набереться N.
   */
  async topMessage(): Promise<string> {
    if (this.stats.seen === 0) return ''; // пошук не вдався — не знаємо, що ще актуальне
    const items = this.db.activeMatches(this.startedAt, CITY.name).flatMap((row) => {
      const text = TextResultSchema.safeParse(JSON.parse(row.text_result_json!));
      const photo = PhotoResultSchema.safeParse(JSON.parse(row.photo_result_json!));
      return text.success && photo.success ? [{ row, text: text.data, photo: photo.data }] : [];
    });
    const top = [];
    for (const item of rankTop(items, items.length)) {
      if (top.length >= TOP_N) break;
      const { row } = item;
      const source = sources.find((s) => s.name === row.source);
      // null (не вдалося перевірити) — лишаємо в топі, щоб не викидати через тимчасовий збій
      const alive = this.openedNow.has(`${row.source}:${row.id}`) || !source || (await source.isAlive(row.url)) !== false;
      if (alive) {
        top.push(item);
      } else {
        this.removeListing(row.source, row.id);
        log(`топ: ${row.id} більше не відкривається → видалено з БД, беру наступне`);
      }
    }
    // NEW — лише при першій появі в топі: top:seen — усі, хто вже був у надісланому топі
    // (top:last — старий формат, лише попередній топ; беремо як стартовий список). Зберігаємо після успішної відправки.
    const prevRaw = this.db.getMeta('top:seen') ?? this.db.getMeta('top:last');
    const seen = prevRaw ? (JSON.parse(prevRaw) as string[]) : [];
    const current = top.map((t) => topKey(t.row));
    this.pendingTopSeen = [...seen.filter((k) => !current.includes(k)), ...current].slice(-TOP_SEEN_MAX);
    return formatTop(top, prevRaw ? new Set(seen) : undefined);
  }

  async alert(key: string, message: string) {
    const metaKey = `alert:${key}`;
    const last = Number(this.db.getMeta(metaKey) ?? 0);
    if (Date.now() - last < ALERT_COOLDOWN_MS) return log(`(алерт «${key}» вже надсилався нещодавно)`);
    try {
      await this.notifier.sendMessage(`🚨 rent-agent: ${message}`);
      if (!DRY_RUN) this.db.setMeta(metaKey, String(Date.now()));
    } catch (err) {
      log(`не вдалося надіслати алерт: ${(err as Error).message}`);
    }
  }

  /** Збирає пошук, оновлює БД, повертає чергу на обробку. */
  async collect(source: SourceAdapter): Promise<QueueItem[]> {
    let summaries: ListingSummary[];
    try {
      summaries = await source.fetchSearch(CITY);
    } catch (err) {
      log(`${source.name}: пошук впав — ${(err as Error).message}`);
      this.errors.push(`${source.name} пошук: ${(err as Error).message}`);
      await this.alert(`${source.name}:search`, `пошук ${source.name} впав: ${(err as Error).message}`);
      return [];
    }
    log(`${source.name}: у пошуку ${summaries.length} оголошень`);
    if (summaries.length === 0) {
      this.errors.push(`${source.name}: 0 оголошень`);
      await this.alert(`${source.name}:empty`, `пошук ${source.name} повернув 0 оголошень — можливо, змінилась розмітка`);
      return [];
    }
    this.stats.seen += summaries.length;

    const firstRun = this.db.isEmpty(source.name, CITY.name);
    if (firstRun) log(`${source.name}: перший запуск — обробляю перші ${FIRST_RUN_LIMIT}, решта skipped_initial`);

    const queue: QueueItem[] = [];
    summaries.forEach((s, i) => {
      const row = this.db.get(s.source, s.id);
      if (!row) {
        const skip = firstRun && i >= FIRST_RUN_LIMIT;
        this.db.insertSummary(s, skip ? 'skipped_initial' : 'new', CITY.name);
        if (!skip) {
          this.stats.newCount++;
          queue.push({ source, summary: s });
        }
        return;
      }
      const { priceChanged } = this.db.touch(s, row);
      if (priceChanged) {
        log(`  ${s.id}: ціна ${row.price_text} → ${s.priceText}`);
        queue.push({ source, summary: s, priceChange: { from: row.price, to: s.price } });
      } else if ((row.status === 'new' || row.status === 'pending_analysis') && row.attempts < MAX_ATTEMPTS) {
        const priceChange = row.price_changed ? { from: row.price_prev, to: row.price } : undefined;
        queue.push({ source, summary: s, priceChange });
      }
    });
    // --recheck: примусово в чергу (спершу), зокрема ті, яких уже немає в пошуку
    const forced: QueueItem[] = [];
    for (const id of RECHECK) {
      const row = this.db.get(source.name, id);
      if (!row || row.city !== CITY.name) continue;
      const queued = queue.find((q) => q.summary.id === id);
      if (queued) {
        queued.force = true;
        continue;
      }
      const summary: ListingSummary = {
        source: row.source, id: row.id, url: row.url, title: row.title, price: row.price,
        priceText: row.price_text, location: row.location, date: row.posted_date, isTop: false,
      };
      forced.push({ source, summary, force: true });
    }
    if (RECHECK.size) log(`${source.name}: примусова перевірка ${forced.length + queue.filter((q) => q.force).length} з ${RECHECK.size}`);
    return [...forced, ...queue];
  }

  /**
   * Повна обробка одного оголошення. Запускається для всіх одночасно:
   * HTTP-запити самі стають у послідовну чергу (http.ts), виклики Claude — не більше CLAUDE_PARALLEL (claude.ts).
   * Повертає 'skipped', якщо до аналізу не дійшло через ліміт Claude.
   */
  async process({ source, summary: s, priceChange, force }: QueueItem, label: string): Promise<'done' | 'skipped'> {
    const say = (msg: string) => log(`${label} ${s.id} ${msg}`);
    const prev = this.db.get(s.source, s.id)!;
    if (claudeLimitHit()) return 'skipped';

    let listing;
    try {
      listing = await source.fetchListing(s);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) {
        this.removeListing(s.source, s.id);
        say('→ сторінка зникла, видалено з БД');
        return 'done';
      }
      this.pageErrors++;
      this.problem(describeProblem('сторінка', err));
      this.db.setStatus(s.source, s.id, 'pending_analysis', { error: `сторінка: ${(err as Error).message}` });
      say(`→ помилка сторінки: ${(err as Error).message}`);
      return 'done';
    }
    this.db.saveDetails(listing);
    this.openedNow.add(`${s.source}:${s.id}`);
    say(`сторінку отримано: ${listing.priceText || 'ціна ?'}${priceChange ? ` (ціна змінилась: ${priceChange.from ?? '?'} → ${priceChange.to ?? '?'} €)` : ''}, фото ${listing.photoUrls.length}, текст ${listing.description.length} симв.`);

    // 1. Текст
    let text: TextResult;
    try {
      text = await analyzeText(listing, priceChange, CITY.name, say);
      this.db.saveTextResult(s.source, s.id, text);
    } catch (err) {
      return this.claudeFailed(s, 'текст', err, say);
    }
    say(`текст: ${text.verdict} ${text.score}/10 — ${text.summary_uk}`);
    if (text.verdict === 'no') say('→ відхилено за текстом');
    if (text.verdict === 'no') {
      const reason = [...text.reasons, ...text.red_flags].join('; ');
      this.db.setStatus(s.source, s.id, 'rejected', { reason: `текст: ${reason}` });
      return 'done';
    }

    // 2. Фото
    if (listing.photoUrls.length === 0) {
      this.db.savePhotoResult(s.source, s.id, null);
      this.db.setStatus(s.source, s.id, 'rejected', { reason: 'немає фото' });
      say('→ без фото, не надсилаю');
      return 'done';
    }
    const dir = photoDir(DATA_DIR, s.source, s.id);
    let photo: PhotoResult;
    const prevPhoto = prev.photo_result_json ? PhotoResultSchema.safeParse(JSON.parse(prev.photo_result_json)) : null;
    // Стара оцінка годиться, лише якщо на диску всі фото: раніше бралися тільки перші 6, така оцінка неповна
    const wanted = Math.min(listing.photoUrls.length, MAX_PHOTOS);
    const samePhotos = prev.photos_json === JSON.stringify(listing.photoUrls) && listPhotos(dir).length >= wanted;
    if (prevPhoto?.success && samePhotos && !force) {
      photo = prevPhoto.data;
      say(`фото без змін, використовую попередню оцінку ${photo.score}/10`);
    } else {
      const dlStarted = Date.now();
      say(`↓ фото: завантажую ${wanted} з ${listing.photoUrls.length}`);
      const files = await downloadPhotos(listing.photoUrls, dir);
      say(`↓ фото: завантажено ${files.length} за ${Math.round((Date.now() - dlStarted) / 1000)} с`);
      if (files.length === 0) {
        this.db.setStatus(s.source, s.id, 'pending_analysis', { error: 'фото не завантажились' });
        this.problem('фото не завантажились з bazos');
        say('→ фото не завантажились');
        return 'done';
      }
      try {
        photo = await analyzePhotos(listing, text, dir, files, MODEL, CITY.name, say);
        this.db.savePhotoResult(s.source, s.id, photo);
      } catch (err) {
        return this.claudeFailed(s, 'фото', err, say);
      }
      say(`фото: ${photo.score}/10 — ${photo.summary_uk}`);
    }
    if (photo.score < PHOTO_SCORE_MIN) {
      say(`→ відхилено за фото (${photo.score} < ${PHOTO_SCORE_MIN})`);
      this.db.setStatus(s.source, s.id, 'rejected', {
        reason: `фото ${photo.score}/10 < ${PHOTO_SCORE_MIN}: ${photo.summary_uk}`,
      });
      return 'done';
    }

    this.db.setStatus(s.source, s.id, 'matched');
    this.stats.matched++;
    await this.deliver(this.db.get(s.source, s.id)!, say);
    return 'done';
  }

  claudeFailed(s: ListingSummary, stage: 'текст' | 'фото', err: unknown, say: (m: string) => void): 'done' | 'skipped' {
    const message = (err as Error).message;
    // Авторизація/ліміт — окремий рядок у підсумку (стосується всієї черги), решта причин рахується поштучно
    if (!(err instanceof ClaudeLimitError)) this.problem(describeProblem(stage, err));
    if (err instanceof ClaudeLimitError) {
      // Не вина оголошення — спробу не рахуємо
      this.db.setStatus(s.source, s.id, 'pending_analysis', { error: `${stage}: ${message}`, countAttempt: false });
      say(err instanceof ClaudeAuthError || claudeAuthFailed() ? `→ Claude не авторизований, відкладено: ${message}` : `→ ліміт Claude, відкладено на наступний запуск`);
      return 'skipped';
    }
    this.db.setStatus(s.source, s.id, 'pending_analysis', { error: `${stage}: ${message}` });
    say(`→ помилка Claude (${stage}): ${message}`);
    return 'done';
  }

  async deliver(row: ListingRow, say: (m: string) => void = (m) => log(`${row.id} ${m}`)) {
    const text = TextResultSchema.parse(JSON.parse(row.text_result_json!));
    const photo = PhotoResultSchema.parse(JSON.parse(row.photo_result_json!));
    const dir = photoDir(DATA_DIR, row.source, row.id);
    const caption = buildCaption(row, text, photo);
    const photos = pickPhotos(dir, listPhotos(dir), photo.best_photos);
    if (DIGEST) {
      if (DRY_RUN) return say('→ ✅ підходить (digest, dry-run)');
      this.db.markNotified(row.source, row.id);
      appendShortlist(SHORTLIST, row, text, photo, caption);
      return say('→ ✅ підходить (digest: без окремого повідомлення), додано в shortlist.md');
    }
    say(`→ Telegram: відправляю ${photos.length} фото + підпис ${caption.length} симв.`);
    try {
      await this.notifier.sendListing(caption, photos);
    } catch (err) {
      this.telegramFailed++;
      return say(`→ Telegram: ${(err as Error).message} (повтор наступного запуску)`);
    }
    if (DRY_RUN) return say('→ ✅ підходить (dry-run, не надіслано)');
    this.db.markNotified(row.source, row.id);
    appendShortlist(SHORTLIST, row, text, photo, caption);
    say('← Telegram: ✅ надіслано, додано в shortlist.md');
  }

  /** Оголошення, що більше не відкривається: прибрати з БД разом із фото на диску. */
  removeListing(source: string, id: string) {
    this.db.remove(source, id);
    rmSync(photoDir(DATA_DIR, source, id), { recursive: true, force: true });
  }

  /** Обробляє оголошення і рахує, чим закінчилось. */
  async processAndCount(item: QueueItem, label: string) {
    const o = this.outcomes;
    if ((await this.process(item, label)) === 'skipped') {
      o.skipped++;
      return;
    }
    o.processed++;
    if (item.priceChange) o.priceChanged++;
    const status = this.db.get(item.summary.source, item.summary.id)?.status;
    if (status === 'matched' || status === 'notified') o.matched++;
    else if (status === 'rejected') o.rejected++;
    else if (!status || status === 'gone') o.gone++; // рядка немає — видалено як зникле
    else o.pending++;
  }

  /** Повідомлення після запуску: скільки проаналізовано і скільки підійшло (лише якщо було що обробляти). */
  async runSummary(left: number) {
    const o = this.outcomes;
    if (!DIGEST && o.processed === 0 && o.skipped === 0 && left === 0) {
      // Пошук пройшов, але нового немає — коротке повідомлення (якщо пошук упав, уже був алерт)
      if (this.stats.seen === 0) return;
      try {
        const sync = this.syncResult ? `\n${syncLine(this.syncResult, DRY_RUN)}` : '';
        await this.notifier.sendMessage(`🔍 Нових квартир не знайдено (у пошуку ${this.stats.seen})${sync}`);
        log('← Telegram: «нових не знайдено» надіслано');
      } catch (err) {
        log(`не вдалося надіслати підсумок: ${(err as Error).message}`);
      }
      return;
    }
    const lines = [
      `📊 rent-agent: у пошуку ${this.stats.seen}, проаналізовано ${o.processed}` +
        (o.priceChanged ? ` (зі зміною ціни ${o.priceChanged})` : ''),
      `✅ підійшло: ${o.matched}`,
      `❌ не підійшло: ${o.rejected}`,
    ];
    if (o.pending) lines.push(`⏳ відкладено через помилки: ${o.pending}`, ...problemLines(this.problems));
    if (o.gone) lines.push(`🗑 зникли: ${o.gone}`);
    if (this.syncResult) lines.push(syncLine(this.syncResult, DRY_RUN));
    if (o.skipped) {
      const why = claudeAuthFailed() ? `🔑 ${AUTH_HINT}` : '⚠️ ліміт підписки Claude вичерпано — продовжу наступного запуску';
      lines.push(`⏸ не проаналізовано: ${o.skipped}`, `   ${why}`);
    }
    if (this.telegramFailed) lines.push(`📨 не вдалося надіслати в Telegram: ${this.telegramFailed} (дошлю наступного запуску)`);
    const stuck = this.db.stuckCount(CITY.name, MAX_ATTEMPTS);
    if (stuck) lines.push(`🧱 застрягли після ${MAX_ATTEMPTS} невдалих спроб: ${stuck} (причина — у лозі/БД, поле error)`);
    if (left - o.skipped > 0) lines.push(`У черзі ще: ${left - o.skipped}`);
    try {
      const top = await this.topMessage();
      await this.notifier.sendMessage(escapeHtml(lines.join('\n')) + (top ? `\n\n${top}` : ''), { html: true });
      if (top && this.pendingTopSeen && !DRY_RUN) this.db.setMeta('top:seen', JSON.stringify(this.pendingTopSeen));
      log('← Telegram: підсумок запуску надіслано');
    } catch (err) {
      log(`не вдалося надіслати підсумок: ${(err as Error).message}`);
    }
  }

  async heartbeat() {
    const now = new Date();
    const today = now.toLocaleDateString('sv-SE'); // YYYY-MM-DD, локальний час
    if (now.getHours() < HEARTBEAT_HOUR || this.db.getMeta('heartbeat') === today) return;
    const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const st = this.db.runStatsSince(since, CITY.name);
    await this.notifier.sendMessage(
      `💓 rent-agent за добу: запусків ${st.runs}, перевірено ${st.seen}, нових ${st.new_count}, підхожих ${st.matched}` +
        (st.errors ? `, з помилками ${st.errors}` : ''),
    );
    if (!DRY_RUN) this.db.setMeta('heartbeat', today);
  }
}

async function main() {
  const release = acquireLock(join(DATA_DIR, 'run.lock'));
  if (!release) {
    log('інший запуск ще працює — виходжу');
    return;
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      release();
      process.exit(130);
    });
  }

  const db = new Db(join(DATA_DIR, 'rent.db'));
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!DRY_RUN && (!token || !chatId)) log('УВАГА: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не задано — вивід у консоль');
  const notifier: Notifier = !DRY_RUN && token && chatId ? new TelegramNotifier(token, chatId) : new ConsoleNotifier();
  const runner = new Runner(db, notifier);
  const runId = db.startRun(CITY.name);
  log(`старт: ${CITY.name}, модель ${MODEL}${DRY_RUN ? ', dry-run' : ''}${DIGEST ? ', digest' : ''}${SYNC ? ', звірка' : ''}${Number.isFinite(LIMIT) ? `, ліміт ${LIMIT}` : ''}`);

  let fatal: Error | undefined;
  try {
    // Підхожі, які не вдалося надіслати минулого разу
    if (!DRY_RUN) for (const row of db.unsentMatches(CITY.name)) await runner.deliver(row);

    let budget = LIMIT;
    let left = 0;
    for (const source of sources) {
      const queue = await runner.collect(source);
      const take = queue.slice(0, Math.max(0, budget));
      budget -= take.length;
      log(`${source.name}: в обробку ${take.length}${queue.length > take.length ? ` з ${queue.length}` : ''}`);
      // Усі одночасно: темп задають черга HTTP і ліміт паралельних викликів Claude
      await Promise.all(take.map((item, i) => runner.processAndCount(item, `[${i + 1}/${take.length}]`)));
      left += queue.length - take.length;
    }
    if (SYNC) await runner.sync();
    await runner.runSummary(left + runner.outcomes.skipped);
    if (runner.pageErrors >= 3) {
      await runner.alert('pages', `${runner.pageErrors} сторінок оголошень не вдалося відкрити/розпарсити — перевір лог`);
    }
    if (claudeAuthFailed()) {
      runner.errors.push('Claude не авторизований');
      await runner.alert('claude-auth', `оголошення не аналізуються. ${AUTH_HINT}`);
      // Для плагіна SwiftBar: тримається, доки якийсь виклик Claude знову не пройде (час першої відмови)
      if (!DRY_RUN && !db.getMeta('claude:auth_failed')) db.setMeta('claude:auth_failed', new Date().toISOString());
    } else if (claudeSucceeded() && !DRY_RUN && db.getMeta('claude:auth_failed')) {
      db.setMeta('claude:auth_failed', '');
    }
    for (const [reason, n] of runner.problems) runner.errors.push(`${reason} ×${n}`);
    if (runner.telegramFailed) runner.errors.push(`Telegram: не надіслано ${runner.telegramFailed}`);
    if (!DIGEST) await runner.heartbeat();
  } catch (err) {
    fatal = err as Error;
    log(`ФАТАЛЬНА ПОМИЛКА: ${fatal.stack ?? fatal.message}`);
    await runner.alert('fatal', `запуск впав: ${fatal.message}`);
  } finally {
    const error = [fatal?.message, ...runner.errors].filter(Boolean).join('; ') || undefined;
    db.finishRun(runId, { ...runner.stats, error });
    db.close();
    release();
  }
  log(`готово: у пошуку ${runner.stats.seen}, нових ${runner.stats.newCount}, підхожих ${runner.stats.matched}`);
  if (fatal) process.exitCode = 1;
}

await main();
