import { fetchPage, HttpError } from '../http.ts';
import type { City } from '../cities.ts';
import type { Listing, ListingSummary, SourceAdapter } from './types.ts';

// Деталі формату сторінок — docs/source-nehnutelnosti.md
const BASE = 'https://www.nehnutelnosti.sk';
// Фільтр пошуку (шлях + query) — nehnutelnostiPath у src/cities.ts
const PAGE_SIZE = 30;
const MAX_PAGES = 30;
const SOURCE = 'nehnutelnosti';

type Json = Record<string, unknown>;

const clean = (s: string) => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Json => (isObj(v) ? v : {});
/** Рядок або число як текст; порожнє і службові значення Next («$undefined», «$41») → null. */
const str = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const s = clean(v);
  return s && !s.startsWith('$') ? s : null;
};

/** Сторінка пошуку: page=1 — без параметра, далі `page=N` (сторінка за останньою віддає 404). */
export function searchPageUrl(page: number, path: string): string {
  return `${BASE}${path}${page > 1 ? `${path.includes('?') ? '&' : '?'}page=${page}` : ''}`;
}

/** ID оголошення з адреси `/detail/<id>/<slug>`; null — це не сторінка оголошення (пошук, головна…). */
export function detailId(url: string): string | null {
  try {
    return new URL(url, BASE).pathname.match(/^\/detail\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function parsePrice(text: string): number | null {
  const m = clean(text).match(/^(\d[\d ]*)(?:,\d+)?\s*€/);
  return m ? Number(m[1].replace(/ /g, '')) : null;
}

/** ISO-дата → «10.11. 2026» (як у bazos), за словацьким часом. */
export function formatDate(iso: unknown): string | null {
  if (typeof iso !== 'string') return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Bratislava', day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${Number(get('day'))}.${Number(get('month'))}. ${get('year')}`;
}

/**
 * Дані сторінки (Next.js App Router) лежать у <script>self.__next_f.push([1,"…"])</script>.
 * Склеєні разом це рядки `<id>:<значення>\n`; довгі тексти — `<id>:T<довжина в байтах, hex>,<текст>` без
 * перенесення в кінці, а в JSON на них посилаються як "$<id>".
 */
export function flightRows(html: string): Map<string, string> {
  let text = '';
  for (const m of html.matchAll(/<script[^>]*>self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)<\/script>/g)) {
    try {
      text += JSON.parse(m[1]) as string;
    } catch {
      // зіпсований шматок — пропускаємо, решта може бути цілою
    }
  }
  const rows = new Map<string, string>();
  const buf = Buffer.from(text, 'utf-8');
  let pos = 0;
  while (pos < buf.length) {
    const colon = buf.indexOf(0x3a, pos);
    if (colon < 0) break;
    const id = buf.toString('latin1', pos, colon);
    // id буває порожнім (рядки «:HL[…]»); щось інше — розбір з'їхав, далі не вгадуємо
    if (!/^[0-9a-f]*$/.test(id)) break;
    if (buf[colon + 1] === 0x54) {
      const comma = buf.indexOf(0x2c, colon);
      const len = comma < 0 ? NaN : parseInt(buf.toString('latin1', colon + 2, comma), 16);
      if (!Number.isFinite(len)) break;
      rows.set(id, buf.toString('utf-8', comma + 1, comma + 1 + len));
      pos = comma + 1 + len;
    } else {
      let nl = buf.indexOf(0x0a, colon);
      if (nl < 0) nl = buf.length;
      rows.set(id, buf.toString('utf-8', colon + 1, nl));
      pos = nl + 1;
    }
  }
  return rows;
}

/** JSON-об'єкт, що починається з `{` у позиції start (до парної дужки); null, якщо не розбирається. */
function jsonObjectAt(text: string, start: number): Json | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, i + 1));
        return isObj(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Усі об'єкти `{"advertisement":{…}}` з даних сторінки (у пошуку — картки, на сторінці оголошення — воно саме). */
function advertisements(rows: Map<string, string>): Json[] {
  const marker = '{"advertisement":{';
  const found: Json[] = [];
  for (const row of rows.values()) {
    for (let i = row.indexOf(marker); i >= 0; i = row.indexOf(marker, i + 1)) {
      const ad = jsonObjectAt(row, i)?.advertisement;
      if (isObj(ad)) found.push(ad);
    }
  }
  return found;
}

/** Дати створення з JSON-LD (schema.org) сторінки пошуку: id → validFrom. У даних Next дати карток немає. */
function searchDates(html: string): Map<string, string> {
  const dates = new Map<string, string>();
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const graph: unknown = (JSON.parse(m[1]) as Json)['@graph'];
      for (const node of Array.isArray(graph) ? graph : []) {
        const elements = obj(obj(node).mainEntity).itemListElement;
        for (const el of Array.isArray(elements) ? elements : []) {
          const item = obj(obj(el).item);
          const id = typeof item.url === 'string' ? detailId(item.url) : null;
          if (id && typeof item.validFrom === 'string') dates.set(id, item.validFrom);
        }
      }
    } catch {
      // JSON-LD лише доповнює картки датою — без нього працюємо далі
    }
  }
  return dates;
}

export function parseSearchPage(html: string): { items: ListingSummary[]; total: number | null } {
  const rows = flightRows(html);
  const dates = searchDates(html);
  let total: number | null = null;
  for (const row of rows.values()) {
    const m = row.match(/"totalCount":(\d+),"advertisementsCount":\d+/);
    if (m) total = Number(m[1]);
  }

  const items: ListingSummary[] = [];
  for (const ad of advertisements(rows)) {
    const id = str(ad.id);
    const title = str(ad.title);
    // Девелоперський проєкт — інша сутність з іншою сторінкою (/detail/developersky-projekt/…), не оголошення
    if (!id || !title || ad.isDevProject === true) continue;
    const priceText = str(obj(ad.price).price) ?? '';
    const slug = str(ad.slug);
    items.push({
      source: SOURCE,
      id,
      url: `${BASE}/detail/${id}${slug ? `/${slug}` : ''}`,
      title,
      price: parsePrice(priceText),
      priceText,
      location: str(obj(ad.address).location) ?? '',
      date: formatDate(dates.get(id)),
      isTop: obj(ad.packages).isTop === true,
    });
  }
  return { items, total };
}

const PARAM_LABELS: Record<string, string> = {
  realEstateState: 'Stav',
  construction: 'Konštrukcia',
  yearOfConstruction: 'Rok výstavby',
  energyRatingCertificate: 'Energetický certifikát',
};
// Поля parameters, які виводяться окремо або не несуть змісту для аналізу
const PARAM_SKIP = new Set(['title', 'price', 'category', 'attributes', 'transaction', 'hasElevator', 'floor', 'numberOfFloors', 'area']);

/** Структуровані параметри оголошення читабельним текстом — щоб текстова модель бачила площу/поверх/енергії. */
function parameterLines(ad: Json): string[] {
  const params = obj(ad.parameters);
  const price = obj(params.price);
  const power = obj(price.powerCosts);
  const lines: string[] = [];
  const add = (label: string, value: string | null) => {
    if (value) lines.push(`- ${label}: ${value}`);
  };

  add('Typ', str(params.title));
  add('Lokalita', str(obj(ad.location).name));
  add('Cena', str(price.price));
  // areIncluded: false приходить і тоді, коли автор нічого не вказав — пишемо лише те, що сказано явно
  const powerValue = str(power.value);
  if (power.areIncluded === true) add('Energie', `zahrnuté v cene${powerValue ? ` (${powerValue})` : ''}`);
  else add('Energie', powerValue ? `${powerValue}, nie sú zahrnuté v cene` : null);
  const area = str(params.area);
  add('Plocha', area ? `${area} m²` : null);
  const floor = str(params.floor);
  const floors = str(params.numberOfFloors);
  add('Poschodie', floor ? `${floor}${floors ? ` z ${floors}` : ''}` : null);
  if (!floor) add('Počet podlaží', floors);
  // hasElevator: false — типове значення, а не «ліфта немає»
  if (params.hasElevator === true) add('Výťah', 'áno');
  for (const [key, value] of Object.entries(params)) {
    if (PARAM_SKIP.has(key) || isObj(value) || Array.isArray(value)) continue;
    add(PARAM_LABELS[key] ?? key, typeof value === 'boolean' ? (value ? 'áno' : 'nie') : str(value));
  }
  for (const attr of Array.isArray(params.attributes) ? params.attributes : []) {
    const label = str(obj(attr).label);
    if (label) add(label, str(obj(attr).value));
  }
  const advertiser = obj(ad.advertiser);
  const agency = str(obj(advertiser.agency).name);
  const type = str(advertiser.type);
  if (type === 'PRIVATE_PERSON') add('Inzerent', 'súkromná osoba');
  else if (type === 'AGENT' || agency) add('Inzerent', `realitná kancelária${agency ? ` (${agency})` : ''}`);
  else add('Inzerent', type);
  return lines;
}

/** Вільний текст опису: рядок або посилання "$<id>" на текстовий рядок даних; контакти сайт ховає за HTML-заглушкою. */
function descriptionText(raw: unknown, rows: Map<string, string>): string {
  let text = typeof raw === 'string' ? raw : '';
  if (/^\$[0-9a-f]+$/.test(text)) text = rows.get(text.slice(1)) ?? '';
  return text
    .replace(/<span class="inline-contact"[^>]*>.*?<\/span>\s*<\/span>/g, '[kontakt skrytý]')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Об'єкт оголошення зі сторінки деталі (той, що має parameters), бажано з потрібним id. */
function detailAd(rows: Map<string, string>, id: string | null): Json | null {
  const ads = advertisements(rows).filter((ad) => isObj(ad.parameters));
  return ads.find((ad) => ad.id === id) ?? ads[0] ?? null;
}

export function parseDetailPage(html: string, summary: Pick<ListingSummary, 'id' | 'url'>): Listing {
  const rows = flightRows(html);
  const ad = detailAd(rows, summary.id);
  const title = ad ? str(ad.title) : null;
  if (!ad || !title) throw new Error(`nehnutelnosti ${summary.id}: дані оголошення не знайдено — змінився формат сторінки?`);
  // Зняте з публікації оголошення сайт ще якийсь час віддає з кодом 200 (isActive: false)
  if (ad.isActive === false) throw new HttpError(410, summary.url);

  const price = obj(obj(ad.parameters).price);
  const priceText = str(price.price) ?? '';
  const params = parameterLines(ad);
  const text = descriptionText(ad.description, rows);
  const photos = obj(ad.media).photos;
  const photoUrls = (Array.isArray(photos) ? photos : [])
    // origUrl — оригінал без зменшення; largeUrl (1560 px) — запасний варіант
    .map((p) => str(obj(p).origUrl) ?? str(obj(p).largeUrl))
    .filter((u): u is string => !!u && u.startsWith('https://'));

  return {
    source: SOURCE,
    id: summary.id,
    url: summary.url,
    title,
    price: typeof price.priceNum === 'number' ? price.priceNum : parsePrice(priceText),
    priceText,
    location: str(obj(ad.location).name) ?? '',
    date: formatDate(ad.createdAt),
    description: [params.length ? `Parametre:\n${params.join('\n')}` : '', text].filter(Boolean).join('\n\n'),
    photoUrls: [...new Set(photoUrls)],
  };
}

export const nehnutelnosti: SourceAdapter = {
  name: SOURCE,

  supports: (city: City) => !!city.nehnutelnostiPath,

  async fetchSearch(city: City) {
    const path = city.nehnutelnostiPath;
    if (!path) throw new Error(`nehnutelnosti: для міста ${city.name} пошук не налаштовано`);
    const byId = new Map<string, ListingSummary>();
    let total: number | null = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      // Сторінка за останньою — 404, тому зайвого запиту не робимо
      if (total !== null && (page - 1) * PAGE_SIZE >= total) break;
      const parsed = parseSearchPage(await fetchPage(searchPageUrl(page, path)).then((p) => p.text));
      total ??= parsed.total;
      if (total === null) throw new Error('nehnutelnosti: не знайдено загальну кількість оголошень — змінився формат сторінки?');
      if (parsed.items.length === 0) break;
      // Дедуп: порядок може зсуватись між запитами
      for (const item of parsed.items) if (!byId.has(item.id)) byId.set(item.id, item);
    }
    if (total !== null && byId.size < total * 0.9) {
      console.warn(`nehnutelnosti: зібрано ${byId.size} унікальних з ${total} заявлених`);
    }
    return [...byId.values()];
  },

  async fetchListing(summary) {
    const page = await fetchPage(summary.url);
    // Видалене оголошення: 307 на /vysledky; зміна slug — 308 на ту саму /detail/<id>/…
    if (detailId(page.url) !== summary.id) throw new HttpError(410, summary.url);
    return parseDetailPage(page.text, summary);
  },

  // GET, а не HEAD: зняте оголошення якийсь час відповідає 200 з isActive: false — це видно лише в тілі
  async isAlive(url) {
    const id = detailId(url);
    if (!id) return null;
    try {
      const page = await fetchPage(url);
      if (detailId(page.url) !== id) return false;
      const ad = detailAd(flightRows(page.text), id);
      return ad ? ad.isActive !== false : null;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return false;
      return null;
    }
  },
};
