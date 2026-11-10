import type { ListingRow } from './db.ts';

export interface SyncResult {
  /** Скільки записів БД не було в поточному пошуку (стільки сторінок перевірено). */
  checked: number;
  /** Сторінки немає — видалено з БД і з диска. */
  removed: number;
  /** Сторінка ще відкривається, хоч у пошуку оголошення немає (зарезервоване, поза фільтром тощо) — лишається. */
  alive: number;
  /** Перевірити не вдалося (мережа, невідоме джерело) — лишається до наступної звірки. */
  unknown: number;
}

interface SyncOptions {
  /** true — сторінка є, false — оголошення видалене, null — перевірити не вдалося. */
  isAlive: (row: ListingRow) => Promise<boolean | null>;
  remove: (row: ListingRow) => void;
  /** У dry-run нічого не видаляється, лише рахується й логується. */
  dryRun?: boolean;
  log?: (msg: string) => void;
}

/**
 * Звірка БД із сайтом (`--sync`): `rows` — записи, яких не було в поточному пошуку. Кожен перевіряється окремо;
 * видаляється лише той, чия сторінка точно не відкривається — сама відсутність у пошуку не є причиною видаляти.
 */
export async function syncGone(rows: ListingRow[], { isAlive, remove, dryRun = false, log = () => {} }: SyncOptions): Promise<SyncResult> {
  const result: SyncResult = { checked: rows.length, removed: 0, alive: 0, unknown: 0 };
  for (const row of rows) {
    let alive: boolean | null;
    try {
      alive = await isAlive(row);
    } catch {
      alive = null;
    }
    if (alive === false) {
      result.removed++;
      if (!dryRun) remove(row);
      log(`звірка: ${row.id} (${row.status}) сторінки немає → ${dryRun ? 'було б видалено (dry-run)' : 'видалено з БД'}`);
    } else if (alive === true) {
      result.alive++;
      log(`звірка: ${row.id} (${row.status}) немає в пошуку, але сторінка відкривається → лишаю`);
    } else {
      result.unknown++;
      log(`звірка: ${row.id} (${row.status}) не вдалося перевірити → лишаю`);
    }
  }
  return result;
}

export function syncLine(r: SyncResult, dryRun = false): string {
  if (r.checked === 0) return '🧹 Звірка: усі оголошення з БД є в пошуку';
  return (
    `🧹 Звірка: поза пошуком ${r.checked} · ${dryRun ? 'було б видалено' : 'видалено'} ${r.removed} · ще живі ${r.alive}` +
    (r.unknown ? ` · не перевірено ${r.unknown}` : '')
  );
}
