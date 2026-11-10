import { describe, expect, it } from 'vitest';
import { buildTextPrompt, enforceMustHave, fillTemplate } from '../src/analyze/index.ts';
import { TextResultSchema, type PhotoResult, type TextResult } from '../src/analyze/schemas.ts';
import { extractJson } from '../src/claude.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, type ListingRow } from '../src/db.ts';
import type { ListingSummary } from '../src/sources/types.ts';
import { buildCaption, DISHWASHER_BONUS, formatTop, pickPhotos, rankTop, topScore } from '../src/telegram.ts';
import { syncGone, syncLine } from '../src/sync.ts';

const text: TextResult = {
  verdict: 'yes',
  score: 8,
  reasons: ['Мебльована', '2 кімнати', 'Новобудова з ліфтом'],
  red_flags: ['Застава 2 місяці'],
  extracted: {
    rooms: 2, area_m2: 50, rent_eur: 550, energies_eur: 140, total_monthly_eur: 690, deposit_eur: 1100,
    heating: 'газовий котел', air_conditioning: null, dishwasher: null, furnished: 'yes', district_or_street: 'Starý Juh',
    floor: null, elevator: true, pets: 'ні', available_from: '1.12.2026', min_term: null, landlord_type: 'owner',
  },
  summary_uk: 'Мебльована 2-кімнатна у новобудові на Старому Юзі.',
};
const photo: PhotoResult = {
  score: 7, renovation: 'новий', kitchen: 'сучасна', bathroom: 'душ', windows: 'пластикові', light: 'світло',
  furniture: 'повністю', red_flags: [], photos_look_real: true, summary_uk: 'Свіжий ремонт.', best_photos: [3, 1, 5],
};
const row = {
  source: 'bazos', id: '1', url: 'https://reality.bazos.sk/inzerat/1/x.php', title: 'Byt', price: 550,
  price_text: '550 €', price_prev: 600, price_changed: 1,
} as ListingRow;

describe('extractJson', () => {
  it('знімає ```json-обгортку', () => expect(extractJson('```json\n{"ok": true}\n```')).toEqual({ ok: true }));
  it('терпить текст навколо', () => expect(extractJson('Ось: {"a": {"b": 1}} готово')).toEqual({ a: { b: 1 } }));
  it('кидає помилку без JSON', () => expect(() => extractJson('нічого')).toThrow());
});

describe('схема тексту', () => {
  it('приймає рядкові числа і null', () => {
    const r = TextResultSchema.safeParse({ ...text, score: '7', extracted: { ...text.extracted, area_m2: 'cca 50' } });
    expect(r.success).toBe(true);
  });
  it('відхиляє неправильний вердикт', () => {
    expect(TextResultSchema.safeParse({ ...text, verdict: 'ok' }).success).toBe(false);
  });
});

describe('buildCaption', () => {
  it('формує підпис у потрібному форматі', () => {
    const c = buildCaption(row, text, photo);
    expect(c).toContain('🏠 2-кімн. · 50 м² · Starý Juh\n💶 550 € + 140 € = 690 €\n💰 Застава: 1100 €');
    expect(c).toContain('🔥 Опалення: газовий котел');
    expect(c).toContain('🍽 Посудомийка: не вказано');
    expect(c).toContain('🛋 Меблі: повністю');
    expect(c).toContain('🏢 Поверх: не вказано, ліфт є');
    expect(c).toContain('👤 Здає: власник');
    expect(c).toContain('✅ Мебльована\n✅ 2 кімнати');
    expect(c).toContain('⚠️ Застава 2 місяці');
    expect(c).toContain('⭐ Текст 8/10 · Фото 7/10 · 🔻 600 → 550 €');
    expect(c.endsWith(row.url)).toBe(true);
  });
  it('невідоме опалення → «не вказано», порожні другорядні пункти не показуються', () => {
    const t = { ...text, extracted: { ...text.extracted, heating: null, pets: null, available_from: null, landlord_type: null } };
    const c = buildCaption(row, t, photo);
    expect(c).toContain('🔥 Опалення: не вказано');
    expect(c).not.toContain('🐾');
    expect(c).not.toContain('📅');
    expect(c).not.toContain('👤');
  });
  it('при довгих текстах факти лишаються', () => {
    const long = { ...text, summary_uk: 'x'.repeat(900), reasons: Array(5).fill('y'.repeat(300)), red_flags: Array(5).fill('z'.repeat(300)) };
    const c = buildCaption(row, long, photo);
    expect(c.length).toBeLessThanOrEqual(1024);
    expect(c).toContain('🔥 Опалення: газовий котел');
    expect(c).toContain('🍽 Посудомийка');
  });
  it('не перевищує 1024 символи', () => {
    const long = { ...text, summary_uk: 'x'.repeat(900), reasons: Array(5).fill('y'.repeat(300)) };
    expect(buildCaption(row, long, photo).length).toBeLessThanOrEqual(1024);
  });
  it('енергії 0 → «з енергіями»', () => {
    const t = { ...text, extracted: { ...text.extracted, energies_eur: 0, total_monthly_eur: 550 } };
    expect(buildCaption(row, t, photo)).toContain('550 € з енергіями');
  });
  it('без 🔻, якщо ціна зросла', () => {
    expect(buildCaption({ ...row, price_prev: 500 }, text, photo)).not.toContain('🔻');
  });
  it('відмітка підлогового опалення лише коли воно є', () => {
    const t = { ...text, extracted: { ...text.extracted, floor_heating: true } };
    expect(buildCaption(row, t, photo)).toContain('♨️ Підлогове опалення: є');
    expect(formatTop([{ row, text: t, photo }]).split('\n\n')[1]).toContain('♨️');
    expect(formatTop([{ row, text, photo }]).split('\n\n')[1]).not.toContain('♨️');
    expect(buildCaption(row, text, photo)).toContain('♨️ Підлогове опалення: не вказано');
  });
  it('відмітка посудомийки лише коли вона є', () => {
    const t = { ...text, extracted: { ...text.extracted, dishwasher: true } };
    expect(buildCaption(row, t, photo)).toContain('🍽 Посудомийка: є');
    expect(formatTop([{ row, text: t, photo }]).split('\n\n')[1]).toContain('🍽');
    expect(formatTop([{ row, text, photo }]).split('\n\n')[1]).not.toContain('🍽');
    // Текст мовчить, але посудомийку видно на фото
    const seen = { ...photo, seen: { dishwasher: true, washing_machine: null } };
    expect(buildCaption(row, text, seen)).toContain('🍽 Посудомийка: є (на фото)');
    expect(buildCaption(row, text, seen)).toContain('🧺 Пральна машина: не вказано');
    expect(formatTop([{ row, text, photo: seen }]).split('\n\n')[1]).toContain('🍽');
    expect(topScore({ row, text, photo: seen })).toBe(topScore({ row, text, photo }) + DISHWASHER_BONUS);
    // Текст прямо каже «немає» — фото його не перекриває
    const no = { ...text, extracted: { ...text.extracted, dishwasher: false } };
    expect(buildCaption(row, no, seen)).toContain('🍽 Посудомийка: немає');
    // Старі записи без поля
    const { dishwasher: _, ...old } = text.extracted;
    expect(buildCaption(row, { ...text, extracted: old }, photo)).toContain('🍽 Посудомийка: не вказано');
  });
});

describe('pickPhotos', () => {
  it('бере найкращі за номерами, доповнює до 4', () => {
    expect(pickPhotos('/d', ['01.jpg', '02.jpg', '03.jpg', '04.jpg', '05.jpg'], [3, 1, 99])).toEqual([
      '/d/03.jpg', '/d/01.jpg', '/d/02.jpg', '/d/04.jpg', '/d/05.jpg',
    ]);
  });
});

describe('промпт', () => {
  it('підставляє змінні і критерії', () => {
    expect(fillTemplate('a {{x}} {{y}}', { x: '1' })).toBe('a 1 {{y}}');
    const p = buildTextPrompt(
      { source: 'bazos', id: '1', url: 'u', title: 'T', price: 500, priceText: '500 €', location: 'Poprad', date: null, description: 'Opis', photoUrls: [] },
      { from: 600, to: 500 },
    );
    expect(p).toContain('# My apartment requirements');
    expect(p).toContain('price changed from 600 € to 500 €');
    expect(p).not.toMatch(/\{\{\w+\}\}/);
    expect(p).toContain('rent in Poprad');
    expect(p).toContain('- Poprad or within');
  });

  it('підставляє місто в промпт і критерії', () => {
    const p = buildTextPrompt(
      { source: 'bazos', id: '1', url: 'u', title: 'T', price: 500, priceText: '500 €', location: 'Košice', date: null, description: 'Opis', photoUrls: [] },
      undefined,
      'Košice',
    );
    expect(p).toContain('rent in Košice');
    expect(p).toContain('- Košice or within');
    expect(p).not.toContain('Poprad');
    expect(p).not.toMatch(/\{\{\w+\}\}/);
  });
});

describe('enforceMustHave', () => {
  it('невиконана обов\'язкова вимога → no з причиною', () => {
    const r = enforceMustHave({ ...text, must_have: [{ requirement: 'До 5 км', met: false, evidence: '9 км' }, { requirement: 'Ціна', met: true, evidence: '500 €' }] });
    expect(r.verdict).toBe('no');
    expect(r.red_flags[0]).toBe('Не виконано: До 5 км — 9 км');
  });
  it('null (невідомо) і старі записи без must_have не чіпає', () => {
    expect(enforceMustHave({ ...text, must_have: [{ requirement: 'x', met: null, evidence: '' }] }).verdict).toBe('yes');
    expect(enforceMustHave(text).verdict).toBe('yes');
  });
});


describe('Db', () => {
  const s: ListingSummary = {
    source: 'bazos', id: '42', url: 'u', title: 'T', price: 600, priceText: '600 €', location: 'Poprad', date: null, isTop: false,
  };

  it('нове → touch без змін → зміна ціни повертає в обробку', () => {
    const db = new Db(':memory:');
    expect(db.isEmpty('bazos')).toBe(true);
    db.insertSummary(s, 'new');
    db.setStatus('bazos', '42', 'rejected', { reason: 'дорого' });
    expect(db.touch(s, db.get('bazos', '42')!).priceChanged).toBe(false);
    expect(db.get('bazos', '42')!.status).toBe('rejected');

    const cheaper = { ...s, price: 550, priceText: '550 €' };
    expect(db.touch(cheaper, db.get('bazos', '42')!).priceChanged).toBe(true);
    const r = db.get('bazos', '42')!;
    expect(r).toMatchObject({ status: 'new', price: 550, price_prev: 600, price_changed: 1 });
  });

  it('pending_analysis рахує спроби, unsentMatches віддає matched', () => {
    const db = new Db(':memory:');
    db.insertSummary(s, 'new');
    db.setStatus('bazos', '42', 'pending_analysis', { error: 'ліміт' });
    db.setStatus('bazos', '42', 'pending_analysis', { error: 'ліміт' });
    expect(db.get('bazos', '42')!.attempts).toBe(2);
    db.setStatus('bazos', '42', 'matched');
    expect(db.unsentMatches()).toHaveLength(1);
    db.markNotified('bazos', '42');
    expect(db.unsentMatches()).toHaveLength(0);
  });

  it('місто: isEmpty/unsentMatches/activeMatches не змішують міста', () => {
    const db = new Db(':memory:');
    db.insertSummary(s, 'new');
    db.insertSummary({ ...s, id: '43' }, 'new', 'Košice');
    expect(db.get('bazos', '42')!.city).toBe('Poprad');
    expect(db.get('bazos', '43')!.city).toBe('Košice');
    expect(db.isEmpty('bazos', 'Košice')).toBe(false);
    expect(db.isEmpty('bazos', 'Bratislava')).toBe(true);
    for (const id of ['42', '43']) {
      db.setStatus('bazos', id, 'matched');
      db.saveTextResult('bazos', id, {});
      db.savePhotoResult('bazos', id, {});
    }
    expect(db.unsentMatches().map((r) => r.id)).toEqual(['42']);
    expect(db.unsentMatches('Košice').map((r) => r.id)).toEqual(['43']);
    expect(db.activeMatches('2000-01-01').map((r) => r.id)).toEqual(['42']);
    expect(db.activeMatches('2000-01-01', 'Košice').map((r) => r.id)).toEqual(['43']);
  });

  it('місто: статистика запусків (heartbeat) не змішує міста', () => {
    const db = new Db(':memory:');
    db.finishRun(db.startRun(), { seen: 160, newCount: 2, matched: 1 });
    db.finishRun(db.startRun('Košice'), { seen: 211, newCount: 191, matched: 23 });
    expect(db.runStatsSince('2000-01-01')).toMatchObject({ runs: 1, seen: 160, new_count: 2, matched: 1 });
    expect(db.runStatsSince('2000-01-01', 'Košice')).toMatchObject({ runs: 1, seen: 211 });
  });

  it('стара БД без колонки city отримує її з Poprad', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rent-db-')), 'rent.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE listings (source TEXT NOT NULL, id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
      price REAL, price_text TEXT NOT NULL DEFAULT '', price_prev REAL, price_changed INTEGER NOT NULL DEFAULT 0,
      location TEXT NOT NULL DEFAULT '', posted_date TEXT, raw_text TEXT, photos_json TEXT, first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL, status TEXT NOT NULL, reject_reason TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      text_result_json TEXT, photo_result_json TEXT, notified_at TEXT, PRIMARY KEY (source, id));
      INSERT INTO listings (source, id, url, title, first_seen, last_seen, status) VALUES ('bazos', '1', 'u', 'T', 'x', 'x', 'notified');`);
    old.close();
    const db = new Db(path);
    expect(db.get('bazos', '1')!.city).toBe('Poprad');
    db.close();
    new Db(path).close(); // повторне відкриття не падає
  });
});

describe('топ', () => {
  const item = (id: string, textScore: number, photoScore: number, fitScore?: number) => ({
    row: { ...row, id, url: `https://x/${id}` },
    text: { ...text, score: textScore, fit_score: fitScore },
    photo: { ...photo, score: photoScore },
  });

  it('сортує за fit_score + фото, а без fit_score бере звичайну оцінку', () => {
    const top = rankTop([item('a', 9, 5, 4), item('b', 6, 8, 8), item('c', 7, 7), item('d', 5, 5)], 3);
    expect(top.map((t) => t.row.id)).toEqual(['b', 'c', 'd']);
  });

  it('посудомийка і підлогове дають по +2: перебивають різницю в 1 бал, але не явно кращу', () => {
    const dw = (i: ReturnType<typeof item>) => ({ ...i, text: { ...i.text, extracted: { ...i.text.extracted, dishwasher: true } } });
    const fh = (i: ReturnType<typeof item>) => ({ ...i, text: { ...i.text, extracted: { ...i.text.extracted, floor_heating: true } } });
    expect(rankTop([item('a', 8, 8), dw(item('b', 8, 7))], 2).map((t) => t.row.id)).toEqual(['b', 'a']); // 17 > 16
    expect(rankTop([item('a', 8, 8), dw(item('b', 7, 7))], 2).map((t) => t.row.id)).toEqual(['a', 'b']); // 16 = 14+2 — нічия, далі кращі фото
    expect(rankTop([item('a', 9, 9), dw(item('b', 8, 7))], 2).map((t) => t.row.id)).toEqual(['a', 'b']); // 18 > 17
    expect(rankTop([item('a', 9, 9), fh(dw(item('b', 8, 7)))], 2).map((t) => t.row.id)).toEqual(['b', 'a']); // 19 > 18
  });

  it('форматує список: посилання в заголовку, ціна, значки, NEW', () => {
    const msg = formatTop(rankTop([item('a', 7, 7), item('b', 6, 8, 8)], 7), new Set(['bazos:a']));
    expect(formatTop([item('a', 7, 7)]).split('\n\n')[1]).not.toContain('NEW');
    expect(msg).toMatch(/^🏆 <b>Топ-2 зараз<\/b>/);
    expect(msg).toContain('1. <b>NEW</b> <a href="https://x/b">2-кімн. · 50 м² · Starý Juh</a>\n      <b>690 €</b> 🔻 було 600 € · 🛋 повністю · ⭐ 8/8');
    expect(msg).toContain('2. <a href="https://x/a">2-кімн. · 50 м² · Starý Juh</a>\n');
    expect(formatTop([])).toBe('');
  });

  it('екранує HTML', () => {
    const t = { ...text, extracted: { ...text.extracted, district_or_street: 'A <b> & B' } };
    expect(formatTop([{ row, text: t, photo }])).toContain('A &lt;b&gt; &amp; B');
  });
});

describe('дата розміщення в підписі', () => {
  it('другим рядком блоку фактів, без пробілу з bazos', () => {
    const c = buildCaption({ ...row, posted_date: '16.10. 2026' } as ListingRow, text, photo);
    expect(c).toContain('Starý Juh\n🗓 На сайті з 16.10.2026\n💶');
  });
  it('без дати рядка немає', () => {
    expect(buildCaption({ ...row, posted_date: null } as ListingRow, text, photo)).not.toContain('На сайті з');
  });
});

describe('syncGone (звірка --sync)', () => {
  const rows = ['gone', 'alive', 'unknown', 'throws'].map((id) => ({ ...row, id, status: 'notified' }) as ListingRow);
  const isAlive = async (r: ListingRow) => {
    if (r.id === 'throws') throw new Error('мережа');
    return r.id === 'gone' ? false : r.id === 'alive' ? true : null;
  };
  it('видаляє лише ті, чия сторінка точно не відкривається', async () => {
    const removed: string[] = [];
    const r = await syncGone(rows, { isAlive, remove: (x) => removed.push(x.id) });
    expect(r).toEqual({ checked: 4, removed: 1, alive: 1, unknown: 2 });
    expect(removed).toEqual(['gone']);
    expect(syncLine(r)).toBe('🧹 Звірка: поза пошуком 4 · видалено 1 · ще живі 1 · не перевірено 2');
  });
  it('у dry-run нічого не видаляє', async () => {
    const removed: string[] = [];
    const r = await syncGone(rows, { isAlive, remove: (x) => removed.push(x.id), dryRun: true });
    expect(r.removed).toBe(1);
    expect(removed).toEqual([]);
  });
});
