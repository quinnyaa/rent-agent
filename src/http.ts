const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Сторінки — пауза 2–5 с; статичні фото — коротша (браузер вантажить їх пачкою при відкритті оголошення)
const PAGE_DELAY: [number, number] = [2000, 5000];
const IMAGE_DELAY: [number, number] = [500, 1000];

let lastRequestAt = 0;
// Усі запити до сайтів — строго послідовно через одну чергу, навіть якщо аналіз іде паралельно
let queue: Promise<unknown> = Promise.resolve();

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function politeDelay([min, max]: [number, number]) {
  const wait = min + Math.random() * (max - min);
  const elapsed = Date.now() - lastRequestAt;
  if (lastRequestAt && elapsed < wait) await sleep(wait - elapsed);
  lastRequestAt = Date.now();
}

export class HttpError extends Error {
  constructor(public status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

const HEADERS = { 'User-Agent': USER_AGENT, 'Accept-Language': 'sk,en;q=0.8' };

async function fetchWithRetry<T>(url: string, delay: [number, number], read: (res: Response) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    await politeDelay(delay);
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
      if (res.ok) return await read(res);
      // 4xx (крім 429) — повтор не допоможе
      if (attempt >= 2 || (res.status < 500 && res.status !== 429)) throw new HttpError(res.status, url);
    } catch (err) {
      if (err instanceof HttpError || attempt >= 2) throw err;
    }
    await sleep(10_000);
  }
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

export function fetchText(url: string): Promise<string> {
  return fetchPage(url).then((p) => p.text);
}

/** Як fetchText, але ще й повертає кінцеву адресу після редиректів. */
export function fetchPage(url: string): Promise<{ text: string; url: string }> {
  return enqueue(() => fetchWithRetry(url, PAGE_DELAY, async (res) => ({ text: await res.text(), url: res.url || url })));
}

/** HEAD без переходу за редиректом: статус і Location. Помилки мережі — кидає. */
export function headPage(url: string): Promise<{ status: number; location: string | null }> {
  return enqueue(async () => {
    await politeDelay(PAGE_DELAY);
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', headers: HEADERS, signal: AbortSignal.timeout(30_000) });
    return { status: res.status, location: res.headers.get('location') };
  });
}

export function fetchBuffer(url: string): Promise<Buffer> {
  return enqueue(() => fetchWithRetry(url, IMAGE_DELAY, async (res) => Buffer.from(await res.arrayBuffer())));
}
