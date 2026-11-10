import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertAllowedUrl, BlockedError, fetchBuffer, fetchPage } from '../src/http.ts';
import { intSetting } from '../src/env.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Паузи ввічливості (2–5 с між запитами) прокручуються фейковим годинником, щоб тест не чекав і не впирався в тайм-аут. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const guarded = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  const result = await guarded;
  if ('error' in result) throw result.error;
  return result.value;
}

describe('assertAllowedUrl', () => {
  it('пропускає https на bazos.sk і піддоменах', () => {
    for (const url of ['https://reality.bazos.sk/inzerat/1/x.php', 'https://www.bazos.sk/img/1/001/1.jpg', 'https://bazos.sk/']) {
      expect(() => assertAllowedUrl(url)).not.toThrow();
    }
  });

  it('відкидає інші хости, http і сміття', () => {
    for (const url of [
      'http://reality.bazos.sk/inzerat/1/',
      'https://evil.example/img/123/1.jpg',
      'https://bazos.sk.evil.example/img/123/1.jpg',
      'https://evilbazos.sk/img/123/1.jpg',
      'https://127.0.0.1/img/123/1.jpg',
      'http://localhost:8080/inzerat/1/',
      'file:///etc/passwd',
      'не адреса',
    ]) {
      expect(() => assertAllowedUrl(url), url).toThrow(BlockedError);
    }
  });
});

describe('запити', () => {
  beforeEach(() => void vi.useFakeTimers());

  it('не йде за редиректом на чужий хост', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(settle(fetchPage('https://reality.bazos.sk/inzerat/1/x.php'))).rejects.toThrow(BlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('іде за редиректом у межах сайту і повертає кінцеву адресу', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/inzerat/')
        ? new Response(null, { status: 301, headers: { location: '/inzeraty/byt/' } })
        : new Response('<html>пошук</html>'),
    );
    vi.stubGlobal('fetch', fetchMock);
    const page = await settle(fetchPage('https://reality.bazos.sk/inzerat/1/x.php'));
    expect(page).toEqual({ text: '<html>пошук</html>', url: 'https://reality.bazos.sk/inzeraty/byt/' });
  });

  it('обриває завелику відповідь', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(26 * 1024 * 1024))));
    await expect(settle(fetchBuffer('https://www.bazos.sk/img/1/001/1.jpg'))).rejects.toThrow(BlockedError);
  });
});

describe('intSetting', () => {
  it('порожнє → типове, коректне → число', () => {
    expect(intSetting('X', undefined, 4, 1, 16)).toBe(4);
    expect(intSetting('X', '', 4, 1, 16)).toBe(4);
    expect(intSetting('X', '8', 4, 1, 16)).toBe(8);
  });

  it('сміття і значення поза межами → типове з попередженням', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const raw of ['abc', '0', '99', '2.5', '-1']) expect(intSetting('X', raw, 4, 1, 16)).toBe(4);
    expect(warn).toHaveBeenCalledTimes(5);
    warn.mockRestore();
  });
});
