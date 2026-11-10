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

/** Адреса поза дозволеними сайтами або завелика відповідь — повтор не допоможе. */
export class BlockedError extends Error {}

const HEADERS = { 'User-Agent': USER_AGENT, 'Accept-Language': 'sk,en;q=0.8' };

// Адреси беруться з HTML сайту (посилання, фото, Location) — ходимо лише на сайти джерел і лише по HTTPS.
// Нове джерело — додати його домен сюди.
const ALLOWED_DOMAINS = ['bazos.sk'];
const MAX_REDIRECTS = 5;
// Стеля розміру відповіді: сторінка bazos ~100 КБ, фото — до кількох МБ
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Кидає BlockedError, якщо адреса не https або не на домені джерела (чи його піддомені). */
export function assertAllowedUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedError(`некоректна адреса: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = ALLOWED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  // Нестандартний порт і логін у адресі звичайним посиланням сайту не потрібні
  const plain = parsed.port === '' && parsed.username === '' && parsed.password === '';
  if (parsed.protocol !== 'https:' || !allowed || !plain) throw new BlockedError(`адреса поза дозволеними сайтами: ${url}`);
}

/** GET із ручним проходом редиректів: кожна адреса в ланцюжку перевіряється до запиту. */
async function fetchFollow(url: string): Promise<{ res: Response; url: string }> {
  for (let hop = 0; ; hop++) {
    assertAllowedUrl(url);
    const res = await fetch(url, { headers: HEADERS, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return { res, url };
    await res.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new BlockedError(`забагато редиректів: ${url}`);
    url = new URL(location, url).href;
  }
}

/** Тіло відповіді, але не більше max байтів — щоб аномальна відповідь не з'їла пам'ять. */
async function readLimited(res: Response, max: number): Promise<Buffer> {
  const tooBig = () => new BlockedError(`відповідь більша за ${Math.round(max / 1024 / 1024)} МБ: ${res.url}`);
  if (Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel();
    throw tooBig();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw tooBig();
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

async function fetchWithRetry(url: string, delay: [number, number], maxBytes: number): Promise<{ body: Buffer; url: string }> {
  for (let attempt = 1; ; attempt++) {
    await politeDelay(delay);
    try {
      const { res, url: finalUrl } = await fetchFollow(url);
      if (res.ok) return { body: await readLimited(res, maxBytes), url: finalUrl };
      await res.body?.cancel();
      // 4xx (крім 429) — повтор не допоможе
      if (attempt >= 2 || (res.status < 500 && res.status !== 429)) throw new HttpError(res.status, url);
    } catch (err) {
      if (err instanceof HttpError || err instanceof BlockedError || attempt >= 2) throw err;
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
  return enqueue(async () => {
    const page = await fetchWithRetry(url, PAGE_DELAY, MAX_PAGE_BYTES);
    return { text: page.body.toString('utf-8'), url: page.url };
  });
}

/** HEAD без переходу за редиректом: статус і Location. Помилки мережі — кидає. */
export function headPage(url: string): Promise<{ status: number; location: string | null }> {
  return enqueue(async () => {
    assertAllowedUrl(url);
    await politeDelay(PAGE_DELAY);
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', headers: HEADERS, signal: AbortSignal.timeout(30_000) });
    return { status: res.status, location: res.headers.get('location') };
  });
}

export function fetchBuffer(url: string): Promise<Buffer> {
  return enqueue(async () => (await fetchWithRetry(url, IMAGE_DELAY, MAX_IMAGE_BYTES)).body);
}
