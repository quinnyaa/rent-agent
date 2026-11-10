/**
 * Міста пошуку. Вибір — `--city <key>` або env CITY (default poprad).
 * `name` підставляється в промпти/criteria.md як {{city}} і пишеться в listings.city.
 */
export interface City {
  key: string;
  name: string;
  /** Query-рядок пошуку на reality.bazos.sk (з «?»). */
  bazosQuery: string;
}

export const CITIES: Record<string, City> = {
  poprad: {
    key: 'poprad',
    name: 'Poprad',
    bazosQuery: '?hledat=&hlokalita=05801&humkreis=5&cenaod=&cenado=750&order=',
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
