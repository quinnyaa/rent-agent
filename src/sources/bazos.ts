import * as cheerio from 'cheerio';
import { fetchPage, fetchText, headPage, HttpError } from '../http.ts';
import { DEFAULT_CITY, type City } from '../cities.ts';
import type { Listing, ListingSummary, SourceAdapter } from './types.ts';

// Деталі розмітки — docs/source-bazos.md
const BASE = 'https://reality.bazos.sk';
const SEARCH_PATH = '/prenajmu/byt/';
// Фільтр пошуку (локація, радіус, ціна) — bazosQuery у src/cities.ts
const PAGE_SIZE = 20;
const MAX_PAGES = 30;

export function searchPageUrl(offset: number, query: string = DEFAULT_CITY.bazosQuery): string {
  return `${BASE}${SEARCH_PATH}${offset ? `${offset}/` : ''}${query}`;
}

const clean = (s: string) => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

export function parsePrice(text: string): number | null {
  const m = clean(text).match(/^([\d ]+)\s*€/);
  return m ? Number(m[1].replace(/ /g, '')) : null;
}

const parseDate = (text: string) => text.match(/\[(\d{1,2}\.\d{1,2}\. ?\d{4})\]/)?.[1] ?? null;

/** Сторінка конкретного оголошення, а не пошук/категорія. */
export const isListingUrl = (url: string) => /\/inzerat\/\d+\//.test(new URL(url, BASE).pathname);

export function parseSearchPage(html: string): { items: ListingSummary[]; total: number | null } {
  const $ = cheerio.load(html);
  const totalMatch = clean($('div.listainzerat .inzeratynadpis').text()).match(/z (\d+)/);
  const items: ListingSummary[] = [];

  // div.listainzerat (шапка таблиці) теж має inzeratyflex, але не має класу inzeraty
  $('div.inzeraty').each((_, el) => {
    const card = $(el);
    const link = card.find('h2.nadpis a').first();
    const href = link.attr('href') ?? '';
    const id = href.match(/\/inzerat\/(\d+)\//)?.[1];
    if (!id) return;
    const priceText = clean(card.find('.inzeratycena').text());
    items.push({
      source: 'bazos',
      id,
      url: new URL(href, BASE).href,
      title: clean(link.text()),
      price: parsePrice(priceText),
      priceText,
      location: clean(card.find('.inzeratylok').html()?.replace(/<br\s*\/?>/gi, ' ') ?? ''),
      date: parseDate(card.find('.velikost10').text()),
      isTop: card.find('.ztop').length > 0,
    });
  });

  return { items, total: totalMatch ? Number(totalMatch[1]) : null };
}

export function parseDetailPage(html: string, summary: Pick<ListingSummary, 'id' | 'url'>): Listing {
  const $ = cheerio.load(html);
  const header = $('div.inzeratydetnadpis');
  const title = clean(header.find('h1').text());
  if (!title) throw new Error(`bazos ${summary.id}: заголовок не знайдено — змінилась розмітка?`);

  const descEl = $('div.popisdetail').first();
  descEl.find('br').replaceWith('\n');
  const description = descEl
    .text()
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Таблиця з полями «Meno:», «Lokalita:», «Cena:» …
  const field = (label: string) => {
    const row = $('td.listadvlevo tr').filter((_, tr) => clean($(tr).children('td').first().text()) === label);
    return row.children('td').slice(1);
  };
  const priceText = clean(field('Cena:').text());
  const location = field('Lokalita:')
    .find('a')
    .map((_, a) => clean($(a).text()))
    .get()
    .join(' ');

  const photoUrls = $('div.carousel img.carousel-cell-image')
    .map((_, img) => $(img).attr('data-flickity-lazyload') ?? $(img).attr('src'))
    .get()
    .filter((u): u is string => !!u && /\/img\/\d+\//.test(u));

  return {
    source: 'bazos',
    id: summary.id,
    url: summary.url,
    title,
    price: parsePrice(priceText),
    priceText,
    location,
    date: parseDate(header.find('.velikost10').text()),
    description,
    photoUrls: [...new Set(photoUrls)],
  };
}

export const bazos: SourceAdapter = {
  name: 'bazos',

  async fetchSearch(city: City) {
    const byId = new Map<string, ListingSummary>();
    let total: number | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      if (total !== null && offset >= total) break;
      const parsed = parseSearchPage(await fetchText(searchPageUrl(offset, city.bazosQuery)));
      total ??= parsed.total;
      if (parsed.items.length === 0) break;
      // Дедуп: порядок може зсуватись між запитами, TOP теж можуть повторюватись
      for (const item of parsed.items) if (!byId.has(item.id)) byId.set(item.id, item);
      if (total === null) throw new Error('bazos: не знайдено загальну кількість оголошень — змінилась розмітка?');
    }
    if (total !== null && byId.size < total * 0.9) {
      console.warn(`bazos: зібрано ${byId.size} унікальних з ${total} заявлених`);
    }
    return [...byId.values()];
  },

  async fetchListing(summary) {
    const page = await fetchPage(summary.url);
    // Видалене оголошення: 301 на сторінку пошуку /inzeraty/<slug>/ замість 404
    if (!isListingUrl(page.url)) throw new HttpError(410, summary.url);
    return parseDetailPage(page.text, summary);
  },

  async isAlive(url) {
    try {
      const { status, location } = await headPage(url);
      if (status === 404 || status === 410) return false;
      if (status >= 300 && status < 400) return !!location && isListingUrl(new URL(location, url).href);
      return status >= 200 && status < 300 ? true : null;
    } catch {
      return null;
    }
  },
};
