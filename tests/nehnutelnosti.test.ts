import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CITIES } from '../src/cities.ts';
import { assertAllowedUrl, BlockedError, HttpError } from '../src/http.ts';
import { sourcesFor } from '../src/sources/index.ts';
import {
  detailId,
  flightRows,
  formatDate,
  nehnutelnosti,
  parseDetailPage,
  parsePrice,
  parseSearchPage,
  searchPageUrl,
} from '../src/sources/nehnutelnosti.ts';
import type { ListingSummary } from '../src/sources/types.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf-8');
const detail = (id: string) => parseDetailPage(fixture(`nehnutelnosti-detail-${id}.html`), { id, url: `https://www.nehnutelnosti.sk/detail/${id}/x` });
const PATH = CITIES.poprad.nehnutelnostiPath!;

/** Мінімальна сторінка з даними Next: рядки flight у одному push. */
const flightPage = (rows: string) => `<html><body><script>self.__next_f.push([1,${JSON.stringify(rows)}])</script></body></html>`;
const adPage = (ad: object) => flightPage(`1:${JSON.stringify(['$', '$L2', null, { advertisement: ad }])}\n`);
const AD = {
  id: 'JuTest00001',
  title: 'Byt',
  isActive: true,
  description: 'Opis',
  createdAt: '2026-11-10T19:10:56.942Z',
  media: { photos: [] },
  location: { name: 'Poprad' },
  parameters: { title: '2 izbový byt na prenájom', price: { price: '500 €/mes.', priceNum: 500 } },
};
const summary = (id: string, slug = 'byt'): ListingSummary => ({
  source: 'nehnutelnosti', id, url: `https://www.nehnutelnosti.sk/detail/${id}/${slug}`, title: 't', price: null, priceText: '', location: '', date: null, isTop: false,
});

/** Підміняє fetch: адреса → відповідь; таймери фейкові, щоб не чекати ввічливі паузи http.ts. */
function mockFetch(routes: Record<string, () => Response>) {
  vi.useFakeTimers();
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`неочікуваний запит: ${url}`);
    return route();
  });
  return calls;
}
async function settle<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  await vi.runAllTimersAsync();
  return promise;
}
const html = (body: string) => new Response(body, { status: 200 });
const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('nehnutelnosti: сторінка пошуку', () => {
  const p1 = parseSearchPage(fixture('nehnutelnosti-search-p1.html'));
  const p4 = parseSearchPage(fixture('nehnutelnosti-search-p4.html'));

  it('знаходить 30 оголошень і загальну кількість', () => {
    expect(p1.items).toHaveLength(30);
    expect(p1.total).toBe(96);
    expect(new Set(p1.items.map((i) => i.id)).size).toBe(30);
  });

  it('парсить поля картки', () => {
    expect(p1.items[0]).toEqual({
      source: 'nehnutelnosti',
      id: 'Ju6N94zLBPM',
      url: 'https://www.nehnutelnosti.sk/detail/Ju6N94zLBPM/na-prenajom-prerobeny-zariadeny-2-izb-byt-s-balkonom-ul-podjavorinskej-poprad',
      title: 'NA PRENÁJOM Prerobený, zariadený 2-izb. byt s balkónom, ul. Podjavorinskej, Poprad',
      price: 600,
      priceText: '600 €/mes.',
      location: 'Podjavorínskej 3387, Poprad, okres Poprad',
      date: '10.11. 2026',
      isTop: false,
    });
  });

  it('ціни числові, текст ціни без змінних частин', () => {
    expect(p1.items.map((i) => i.price).slice(0, 5)).toEqual([600, 430, 460, 700, 600]);
    expect(p1.items.every((i) => /^\d+ €\/mes\.$/.test(i.priceText))).toBe(true);
    // Повторний розбір тієї ж сторінки дає той самий priceText (від нього залежить price_changed)
    expect(parseSearchPage(fixture('nehnutelnosti-search-p1.html')).items.map((i) => i.priceText)).toEqual(p1.items.map((i) => i.priceText));
  });

  it('розпізнає TOP-оголошення і дати', () => {
    expect(p1.items.filter((i) => i.isTop)).toHaveLength(11);
    expect(p1.items.every((i) => /^\d{1,2}\.\d{1,2}\. \d{4}$/.test(i.date ?? ''))).toBe(true);
  });

  it('остання сторінка неповна (6), разом із першою — 36 унікальних ID', () => {
    expect(p4.items).toHaveLength(6);
    expect(p4.total).toBe(96);
    expect(new Set([...p1.items, ...p4.items].map((i) => i.id)).size).toBe(36);
  });

  it('сторінка без даних (404, чужа розмітка) — порожньо, total невідомий', () => {
    expect(parseSearchPage('<html><title>Stránka nebola nájdená</title></html>')).toEqual({ items: [], total: null });
  });

  it('формує URL пагінації, не чіпаючи фільтр користувача', () => {
    expect(searchPageUrl(1, PATH)).toBe(`https://www.nehnutelnosti.sk${PATH}`);
    expect(searchPageUrl(4, PATH)).toBe(`https://www.nehnutelnosti.sk${PATH}&page=4`);
    expect(searchPageUrl(2, '/vysledky/poprad/prenajom')).toBe('https://www.nehnutelnosti.sk/vysledky/poprad/prenajom?page=2');
    expect(PATH).toContain('categories=11&categories=12&categories=300001&categories=16&categories=17&categories=18&categories=200000&priceTo=750&priceFrom=300');
    expect(PATH).not.toContain('order='); // заборонено robots.txt
  });
});

describe('nehnutelnosti: обхід пошуку', () => {
  it('ходить по сторінках до total і не запитує сторінку за останньою', async () => {
    const card = (n: number) => ({ advertisement: { id: `JuCard${n}`, title: `Byt ${n}`, slug: `byt-${n}`, price: { price: '500 €/mes.' }, address: { location: 'Poprad' }, packages: { isTop: false } } });
    const page = (from: number, count: number) =>
      flightPage(`1:${JSON.stringify({ totalCount: 35, advertisementsCount: count, items: Array.from({ length: count }, (_, i) => card(from + i)) })}\n`);
    const base = 'https://www.nehnutelnosti.sk/vysledky/test/prenajom';
    const calls = mockFetch({ [base]: () => html(page(0, 30)), [`${base}?page=2`]: () => html(page(30, 5)) });
    const items = await settle(nehnutelnosti.fetchSearch({ key: 't', name: 'Test', bazosQuery: '', nehnutelnostiPath: '/vysledky/test/prenajom' }));
    expect(items).toHaveLength(35);
    expect(calls).toEqual([base, `${base}?page=2`]);
  });

  it('падає, якщо на сторінці немає загальної кількості', async () => {
    mockFetch({ 'https://www.nehnutelnosti.sk/vysledky/test/prenajom': () => html('<html></html>') });
    await expect(settle(nehnutelnosti.fetchSearch({ key: 't', name: 'Test', bazosQuery: '', nehnutelnostiPath: '/vysledky/test/prenajom' }))).rejects.toThrow(/кількість/);
  });
});

describe('nehnutelnosti: сторінка оголошення', () => {
  it('витягує поля, блок параметрів перед описом і всі фото в оригіналі', () => {
    const l = detail('Ju6N94zLBPM');
    expect(l.title).toBe('NA PRENÁJOM Prerobený, zariadený 2-izb. byt s balkónom, ul. Podjavorinskej, Poprad');
    expect(l.price).toBe(600);
    expect(l.priceText).toBe('600 €/mes.');
    expect(l.location).toBe('Podjavorínskej 3387, Poprad, okres Poprad');
    expect(l.date).toBe('10.11. 2026');
    expect(l.description).toMatch(/^Parametre:\n- Typ: 2 izbový byt na prenájom\n/);
    for (const line of ['- Plocha: 54 m²', '- Poschodie: 3 z 8', '- Stav: Kompletná rekonštrukcia', '- Rok výstavby: 1990', '- Vykurovanie: Ústredné', '- Energetický certifikát: nie je', '- Inzerent: realitná kancelária']) {
      expect(l.description).toContain(line);
    }
    // hasElevator: false — типове значення, не твердження
    expect(l.description).not.toContain('Výťah');
    // Вільний текст — з окремого текстового рядка даних ("$2f"), після параметрів
    expect(l.description).toContain('\n\nPonúkam Vám NA PRENÁJOM zariadený 2 izbový byt');
    expect(l.description).toContain('- depozit vo výške dvojmesačného nájmu');
    expect(l.description).toContain('[kontakt skrytý]');
    expect(l.description).not.toMatch(/<span|inline-contact|\$2f/);
    expect(l.photoUrls).toHaveLength(13);
    expect(new Set(l.photoUrls).size).toBe(13);
    expect(l.photoUrls[0]).toBe('https://img.unitedclassifieds.sk/foto/ZmlsdGVyczpmb3JtYXQod2VicCkvanVs/Yw6uhrX39_fss?st=LVUyk8OFrKX670ZH9A_821Y6-DBPQc7xveIXY0adb88&ts=1794343153&e=0');
    // Оригінал («filters:format(webp)/jul» у base64), а не зменшені fit-in/…
    expect(l.photoUrls.every((u) => u.startsWith('https://img.unitedclassifieds.sk/foto/ZmlsdGVyczpmb3JtYXQod2VicCkvanVs/'))).toBe(true);
    expect(() => l.photoUrls.forEach(assertAllowedUrl)).not.toThrow();
  });

  it('приватне оголошення: енергії окремо, опис просто рядком', () => {
    const l = detail('JuZgbdWm1Au');
    expect(l.price).toBe(430);
    expect(l.description).toContain('- Energie: 110 €/mes., nie sú zahrnuté v cene');
    expect(l.description).toContain('- Inzerent: súkromná osoba');
    expect(l.description).toContain('Cena nájmu je 430€+ energie.');
    expect(l.photoUrls).toHaveLength(11);
  });

  it('без площі й поверху: рядків про них немає, енергії в ціні', () => {
    const l = detail('JufmfeiAC6d');
    expect(l.description).toContain('- Energie: zahrnuté v cene');
    expect(l.description).not.toMatch(/Plocha|Poschodie|undefined/);
    expect(l.date).toBe('22.9. 2026');
    expect(l.photoUrls).toHaveLength(11);
  });

  it('падає з зрозумілою помилкою, якщо даних оголошення немає', () => {
    expect(() => parseDetailPage('<html></html>', { id: '1', url: 'u' })).toThrow(/дані оголошення/);
  });

  it('зняте з публікації (isActive: false) → HttpError 410', () => {
    const err = (() => {
      try {
        parseDetailPage(adPage({ ...AD, isActive: false }), { id: AD.id, url: 'u' });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(410);
  });
});

describe('nehnutelnosti: зникле оголошення', () => {
  const s = summary(AD.id);

  it('fetchListing: редирект на /vysledky → HttpError 410', async () => {
    mockFetch({ [s.url]: () => redirect(307, 'https://www.nehnutelnosti.sk/vysledky'), 'https://www.nehnutelnosti.sk/vysledky': () => html('<html>пошук</html>') });
    await expect(settle(nehnutelnosti.fetchListing(s))).rejects.toMatchObject({ status: 410 });
  });

  it('fetchListing: редирект на новий slug того ж оголошення — не зникле', async () => {
    const moved = `https://www.nehnutelnosti.sk/detail/${AD.id}/novy-slug`;
    mockFetch({ [s.url]: () => redirect(308, moved), [moved]: () => html(adPage(AD)) });
    const l = await settle(nehnutelnosti.fetchListing(s));
    expect(l.title).toBe('Byt');
    expect(l.description).toBe('Parametre:\n- Typ: 2 izbový byt na prenájom\n- Lokalita: Poprad\n- Cena: 500 €/mes.\n\nOpis');
  });

  it('isAlive: живе → true, редирект на пошук → false, isActive: false → false', async () => {
    mockFetch({ [s.url]: () => html(adPage(AD)) });
    expect(await settle(nehnutelnosti.isAlive(s.url))).toBe(true);
    vi.unstubAllGlobals();
    mockFetch({ [s.url]: () => redirect(307, '/vysledky'), 'https://www.nehnutelnosti.sk/vysledky': () => html('<html></html>') });
    expect(await settle(nehnutelnosti.isAlive(s.url))).toBe(false);
    vi.unstubAllGlobals();
    mockFetch({ [s.url]: () => html(adPage({ ...AD, isActive: false })) });
    expect(await settle(nehnutelnosti.isAlive(s.url))).toBe(false);
  });

  it('isAlive: 404 → false; 5xx, мережа, незрозуміла сторінка → null', async () => {
    mockFetch({ [s.url]: () => new Response('', { status: 404 }) });
    expect(await settle(nehnutelnosti.isAlive(s.url))).toBe(false);
    vi.unstubAllGlobals();
    mockFetch({ [s.url]: () => new Response('', { status: 503 }) });
    expect(await settle(nehnutelnosti.isAlive(s.url))).toBeNull();
    vi.unstubAllGlobals();
    mockFetch({});
    expect(await settle(nehnutelnosti.isAlive(s.url))).toBeNull();
    vi.unstubAllGlobals();
    mockFetch({ [s.url]: () => html('<html>captcha</html>') });
    expect(await settle(nehnutelnosti.isAlive(s.url))).toBeNull();
    expect(await nehnutelnosti.isAlive('https://www.nehnutelnosti.sk/vysledky')).toBeNull();
  });
});

describe('nehnutelnosti: місто без налаштованого пошуку', () => {
  it('джерело пропускається повністю, а не повертає порожній список', async () => {
    expect(sourcesFor(CITIES.poprad).map((s) => s.name)).toEqual(['bazos', 'nehnutelnosti']);
    expect(CITIES.kosice.nehnutelnostiPath).toBeUndefined();
    expect(sourcesFor(CITIES.kosice).map((s) => s.name)).toEqual(['bazos']);
    // Якщо все ж викликати напряму — помилка, а не [] (0 оголошень Runner.collect вважає поломкою сайту)
    await expect(nehnutelnosti.fetchSearch(CITIES.kosice)).rejects.toThrow(/не налаштовано/);
  });
});

describe('nehnutelnosti: дрібниці', () => {
  it.each([
    ['600 €/mes.', 600],
    ['1 200 €/mes.', 1200],
    ['1 200 €/mes.', 1200],
    ['Cena dohodou', null],
    ['Info v RK', null],
    ['', null],
  ])('parsePrice(%s) → %s', (text, expected) => expect(parsePrice(text)).toBe(expected));

  it('detailId', () => {
    expect(detailId('https://www.nehnutelnosti.sk/detail/Ju6N94zLBPM/slug')).toBe('Ju6N94zLBPM');
    expect(detailId('https://www.nehnutelnosti.sk/detail/Ju_AYnvmH7X')).toBe('Ju_AYnvmH7X');
    expect(detailId('https://www.nehnutelnosti.sk/vysledky')).toBeNull();
    expect(detailId('https://www.nehnutelnosti.sk/')).toBeNull();
  });

  it('formatDate — словацький час', () => {
    expect(formatDate('2026-11-10T19:10:56.942Z')).toBe('10.11. 2026');
    expect(formatDate('2026-11-10T23:30:00.000Z')).toBe('11.11. 2026');
    expect(formatDate('сміття')).toBeNull();
    expect(formatDate(undefined)).toBeNull();
  });

  it('flightRows: довжина текстового рядка — в байтах, шматки push склеюються', () => {
    const text = 'Čučoriedky – 5 €\nдругий рядок';
    const rows = `1:{"a":"$2"}\n2:T${Buffer.byteLength(text).toString(16)},${text}3:["x"]\n`;
    const page = `<script>self.__next_f.push([1,${JSON.stringify(rows.slice(0, 20))}])</script><script>self.__next_f.push([1,${JSON.stringify(rows.slice(20))}])</script>`;
    expect([...flightRows(page)]).toEqual([['1', '{"a":"$2"}'], ['2', text], ['3', '["x"]']]);
  });

  it('дозволені лише nehnutelnosti.sk і хост фото', () => {
    for (const url of ['https://www.nehnutelnosti.sk/detail/x/y', 'https://img.unitedclassifieds.sk/foto/a/b?st=1']) {
      expect(() => assertAllowedUrl(url)).not.toThrow();
    }
    for (const url of ['https://unitedclassifieds.sk/x', 'https://cdn.unitedclassifieds.sk/x', 'https://evilnehnutelnosti.sk/x', 'https://img.unitedclassifieds.sk.evil.example/x']) {
      expect(() => assertAllowedUrl(url), url).toThrow(BlockedError);
    }
  });
});
