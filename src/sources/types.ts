import type { City } from '../cities.ts';

/** Картка зі сторінки пошуку (дешево, без відкриття оголошення). */
export interface ListingSummary {
  source: string;
  id: string;
  url: string;
  title: string;
  price: number | null;
  priceText: string;
  location: string;
  date: string | null;
  isTop: boolean;
}

/** Повне оголошення — однаковий формат для всіх джерел. */
export interface Listing {
  source: string;
  id: string;
  url: string;
  title: string;
  price: number | null;
  priceText: string;
  location: string;
  date: string | null;
  description: string;
  photoUrls: string[];
}

export interface SourceAdapter {
  name: string;
  /** Обходить усі сторінки пошуку для міста, повертає унікальні картки в порядку сайту. */
  fetchSearch(city: City): Promise<ListingSummary[]>;
  /** Кидає HttpError 404/410, якщо оголошення видалене. */
  fetchListing(summary: ListingSummary): Promise<Listing>;
  /** Чи сторінка оголошення ще відкривається. null — не вдалося перевірити (мережа/5xx). */
  isAlive(url: string): Promise<boolean | null>;
}
