import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isListingUrl, parseDetailPage, parsePrice, parseSearchPage, searchPageUrl } from '../src/sources/bazos.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf-8');

describe('bazos: сторінка пошуку', () => {
  const p1 = parseSearchPage(fixture('bazos-search-p1.html'));

  it('знаходить 20 карток і загальну кількість', () => {
    expect(p1.items).toHaveLength(20);
    expect(p1.total).toBe(152);
  });

  it('не плутає шапку таблиці з карткою', () => {
    expect(p1.items.every((i) => /^\d+$/.test(i.id))).toBe(true);
  });

  it('парсить поля картки', () => {
    expect(p1.items[0]).toEqual({
      source: 'bazos',
      id: '196497972',
      url: 'https://reality.bazos.sk/inzerat/196497972/kompletne-zariadeny-2-izbovy-byt-v-novostavbe-jedlicka.php',
      title: 'Kompletne zariadený 2 izbový byt v novostavbe Jedlička',
      price: 550,
      priceText: '550 €',
      location: 'Poprad 058 01',
      date: '3.11. 2026',
      isTop: true,
    });
  });

  it('розпізнає TOP-оголошення', () => {
    expect(p1.items.filter((i) => i.isTop)).toHaveLength(7);
  });

  it('перша (20) і остання неповна (12) сторінки дають 32 унікальні ID', () => {
    const ids = new Set<string>();
    let count = 0;
    for (const p of [1, 8]) {
      const { items } = parseSearchPage(fixture(`bazos-search-p${p}.html`));
      count += items.length;
      items.forEach((i) => ids.add(i.id));
    }
    expect(count).toBe(32);
    expect(ids.size).toBe(32);
  });

  it('формує URL пагінації', () => {
    expect(searchPageUrl(0)).toMatch(/^https:\/\/reality\.bazos\.sk\/prenajmu\/byt\/\?hledat=&hlokalita=05801&humkreis=5&cenaod=&cenado=\d+&order=$/);
    expect(searchPageUrl(40)).toContain('/prenajmu/byt/40/?');
  });
});

describe('bazos: сторінка оголошення', () => {
  it('витягує всі поля і всі фото в повному розмірі', () => {
    const l = parseDetailPage(fixture('bazos-detail-196497972.html'), {
      id: '196497972',
      url: 'https://reality.bazos.sk/inzerat/196497972/x.php',
    });
    expect(l.title).toBe('Kompletne zariadený 2 izbový byt v novostavbe Jedlička');
    expect(l.price).toBe(550);
    expect(l.location).toBe('058 01 Poprad');
    expect(l.date).toBe('3.11. 2026');
    expect(l.description).toMatch(/^Hľadáte príjemný/);
    expect(l.description).toContain('Depozit: 2-mesačný');
    expect(l.description).toContain('\n');
    expect(l.description).not.toContain('<br');
    expect(l.photoUrls).toHaveLength(13);
    expect(l.photoUrls[0]).toBe('https://www.bazos.sk/img/1/972/196497972.jpg?t=1792597100');
    expect(l.photoUrls.every((u) => !u.includes('/1t/'))).toBe(true);
  });

  it('бере дату з шапки, а не з блоку схожих оголошень', () => {
    const l = parseDetailPage(fixture('bazos-detail-197124498.html'), { id: '197124498', url: 'u' });
    expect(l.date).toBe('2.11. 2026');
    expect(l.photoUrls).toHaveLength(6);
    expect(l.description).toContain('Je nezariadený.');
    expect(l.description).not.toContain('&nbsp;');
  });

  it('гарсоньєра з 3 фото', () => {
    const l = parseDetailPage(fixture('bazos-detail-197111926.html'), { id: '197111926', url: 'u' });
    expect(l.title).toBe('Na PRENÁJOM garsónka, ul. Pavlovova, Poprad');
    expect(l.price).toBe(400);
    expect(l.photoUrls).toHaveLength(3);
  });

  it('падає з зрозумілою помилкою, якщо розмітка інша', () => {
    expect(() => parseDetailPage('<html></html>', { id: '1', url: 'u' })).toThrow(/заголовок/);
  });
});

describe('parsePrice', () => {
  it.each([
    ['550 €', 550],
    ['   1 200 €', 1200],
    ['Dohodou', null],
    ['V texte', null],
  ])('%s → %s', (text, expected) => expect(parsePrice(text)).toBe(expected));
});

describe('isListingUrl', () => {
  it('сторінка оголошення', () => expect(isListingUrl('https://reality.bazos.sk/inzerat/196186050/3-izbovy-byt.php')).toBe(true));
  it('редирект видаленого на пошук', () => expect(isListingUrl('https://reality.bazos.sk/inzeraty/delta-pekny/')).toBe(false));
});
