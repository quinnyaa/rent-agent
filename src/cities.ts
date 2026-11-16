/**
 * Міста пошуку. Вибір — `--city <key>` або env CITY (default poprad).
 * `name` підставляється в промпти/criteria.md як {{city}} і пишеться в listings.city.
 */
export interface City {
  key: string;
  name: string;
  /** Query-рядок пошуку на reality.bazos.sk (з «?»). */
  bazosQuery: string;
  /**
   * Пошук на nehnutelnosti.sk: шлях із query, як в адресному рядку (без `page=`; `order=` не додавати — robots.txt).
   * Не задано — джерело nehnutelnosti для міста пропускається.
   */
  nehnutelnostiPath?: string;
}

export const CITIES: Record<string, City> = {
  poprad: {
    key: 'poprad',
    name: 'Poprad',
    bazosQuery: '?hledat=&hlokalita=05801&humkreis=5&cenaod=&cenado=750&order=',
    // categories: 11/12/300001 — 1/2/3-кімнатні, 16 apartmány, 17 lofty, 18 mezonety, 200000 domy (docs/source-nehnutelnosti.md)
    nehnutelnostiPath:
      '/vysledky/poprad/prenajom?categories=11&categories=12&categories=300001&categories=16&categories=17&categories=18&categories=200000&priceTo=750&priceFrom=300',
  },
  kosice: {
    key: 'kosice',
    name: 'Košice',
    // Канонічна форма, як у посиланнях пагінації bazos: зайві rubriky/Submit/crp/kitx ламають сторінки 2+
    bazosQuery: '?hledat=&hlokalita=04001&humkreis=5&cenaod=400&cenado=750&order=',
  },
  mikulas: {
    key: 'mikulas',
    name: 'Liptovský Mikuláš',
    bazosQuery: '?hledat=&hlokalita=03101&humkreis=5&cenaod=&cenado=700&order=',
  },
  bratislava: {
    key: 'bratislava',
    name: 'Bratislava',
    bazosQuery: '?hledat=&hlokalita=81101&humkreis=10&cenaod=450&cenado=800&order=',
  },
};

export const DEFAULT_CITY = CITIES.poprad;

export function getCity(key: string | undefined): City {
  if (!key) return DEFAULT_CITY;
  const city = CITIES[key.toLowerCase()];
  if (!city) throw new Error(`невідоме місто «${key}»; доступні: ${Object.keys(CITIES).join(', ')}`);
  return city;
}
