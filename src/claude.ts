import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import { envInt } from './env.ts';

/** Ліміт підписки вичерпано — далі в цьому запуску Claude не викликаємо. */
export class ClaudeLimitError extends Error {}
/**
 * CLI не залогінений / OAuth-токен прострочений. Поводиться як ліміт (не вина оголошення, спроби не рахуються,
 * нові виклики в цьому запуску не стартують), але потребує ручного `claude auth login`.
 */
export class ClaudeAuthError extends ClaudeLimitError {}
export class ClaudeError extends Error {}

export interface ClaudeOptions {
  model: string;
  /**
   * JPEG у base64 — ідуть у тому ж повідомленні перед текстом промпту, з підписами «Photo 1:», «Photo 2:»…
   * Модель бачить усе за один хід, без інструменту Read (з Read було ~17 ходів і контекст щоразу заново).
   */
  images?: string[];
  /** false — без «роздумів» (MAX_THINKING_TOKENS=0): вихідних токенів у рази менше. За замовчуванням — як у CLI. */
  thinking?: boolean;
  timeoutMs?: number;
  /** low | medium | high | xhigh | max; не задано — дефолт CLI. */
  effort?: string;
  /** Назва кроку для логу ("текст", "фото") і куди писати події. */
  tag?: string;
  log?: (msg: string) => void;
}

const MAX_PARALLEL = envInt('CLAUDE_PARALLEL', 4, 1, 16);
let running = 0;
const waiting: (() => void)[] = [];
let limitHit: string | null = null;
let authFailed = false;
let succeeded = false;

/** Не більше MAX_PARALLEL процесів claude одночасно. */
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export const claudeLimitHit = () => limitHit !== null;
export const claudeAuthFailed = () => authFailed;
/** Хоч один виклик у цьому запуску пройшов — отже, CLI авторизований. */
export const claudeSucceeded = () => succeeded;

const systemPrompt = () => readFileSync(new URL('../prompts/system.md', import.meta.url), 'utf-8').trim();

const AUTH_RE = /failed to authenticate|token has expired|re-authenticate|invalid api key|please run \/login|not logged in|authentication_error/i;
const LIMIT_RE = /usage limit|rate limit|limit reached|hit your limit|out of extra usage|credit balance/i;

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Тільки підписка: без ключа API CLI не зможе піти в платний API
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  // Якщо скрипт запущено зсередини сесії Claude Code
  delete env.CLAUDECODE;
  return env;
}

export function runClaude(prompt: string, opts: ClaudeOptions): Promise<string> {
  return withSlot(async () => {
    // Ліміт вичерпано іншим викликом — не запускаємо нові процеси
    if (limitHit) throw new ClaudeLimitError(`пропущено: ${limitHit}`);
    try {
      const result = await spawnClaude(prompt, opts);
      succeeded = true;
      return result;
    } catch (err) {
      if (err instanceof ClaudeLimitError) limitHit ??= err.message;
      if (err instanceof ClaudeAuthError) authFailed = true;
      throw err;
    }
  });
}

async function spawnClaude(prompt: string, opts: ClaudeOptions): Promise<string> {
  const tag = opts.tag ?? 'запит';
  const started = Date.now();
  const secs = () => `${Math.round((Date.now() - started) / 1000)} с`;
  const mode = `${opts.model}${opts.effort ? `, effort ${opts.effort}` : ''}${opts.thinking === false ? ', без роздумів' : ''}`;
  opts.log?.(`→ Claude: ${tag} відправлено (${mode})`);
  try {
    const { result, usage } = await spawnClaudeRaw(prompt, opts);
    opts.log?.(`← Claude: ${tag} отримано за ${secs()}${usage ? ` · ${usage}` : ''}`);
    return result;
  } catch (err) {
    opts.log?.(`✗ Claude: ${tag} помилка за ${secs()}`);
    throw err;
  }
}

interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** Підсумковий рядок `{"type":"result",…}` з виводу CLI. */
interface ClaudeResult {
  type?: string;
  is_error?: boolean;
  result?: string;
  subtype?: string;
  num_turns?: number;
  total_cost_usd?: number;
  /** Сумарно за всі запити процесу, по моделях (включно зі службовими викликами CLI). */
  modelUsage?: Record<string, ModelUsage>;
}

/** «вхід 3200 (кеш 0), вихід 450, ходів 1, ≈$0.0095» — для логу, щоб бачити витрати токенів. */
export function formatUsage(out: ClaudeResult): string | undefined {
  const models = Object.values(out.modelUsage ?? {});
  if (!models.length) return undefined;
  let input = 0, cached = 0, output = 0;
  for (const m of models) {
    cached += m.cacheReadInputTokens ?? 0;
    input += (m.inputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0) + (m.cacheReadInputTokens ?? 0);
    output += m.outputTokens ?? 0;
  }
  const cost = out.total_cost_usd !== undefined ? `, ≈$${out.total_cost_usd.toFixed(4)}` : '';
  return `вхід ${input} (кеш ${cached}), вихід ${output}${out.num_turns ? `, ходів ${out.num_turns}` : ''}${cost}`;
}

/** Одне повідомлення користувача для `--input-format stream-json`: спершу фото з номерами, потім текст. */
export function buildUserMessage(prompt: string, images: string[] = []): string {
  const content = [
    ...images.flatMap((data, i) => [
      { type: 'text', text: `Photo ${i + 1}:` },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
    ]),
    { type: 'text', text: prompt },
  ];
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

/** Шукає рядок `type: result` у виводі `--output-format stream-json` (по JSON-об'єкту на рядок). */
function parseResult(stdout: string): ClaudeResult | undefined {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const obj = JSON.parse(line) as ClaudeResult;
      if (obj.type === 'result') return obj;
    } catch {
      /* не JSON-рядок — пропускаємо */
    }
  }
  return undefined;
}

function spawnClaudeRaw(prompt: string, opts: ClaudeOptions): Promise<{ result: string; usage?: string }> {
  const args = [
    '-p',
    // stream-json на вході — щоб передати фото прямо в повідомленні; на виході він тоді обов'язковий (з --verbose)
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', opts.model,
    '--tools', '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--permission-mode', 'dontAsk',
    // Не підтягувати CLAUDE.md, налаштування й хуки з cwd/батьківських папок/~/.claude:
    // інакше CLAUDE.md проєкту (~3k токенів) додається до кожного виклику
    '--setting-sources', '',
    // Замість довгого системного промпту Claude Code — короткий свій
    '--system-prompt', systemPrompt(),
  ];
  if (opts.effort) args.push('--effort', opts.effort);
  const env = childEnv();
  if (opts.thinking === false) env.MAX_THINKING_TOKENS = '0';

  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN || 'claude', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new ClaudeError(`claude: тайм-аут ${opts.timeoutMs ?? 300_000} мс`));
    }, opts.timeoutMs ?? 300_000);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ClaudeError(`claude не запустився: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = parseResult(stdout);
      const message = out?.result ?? (stderr || stdout).trim();
      if (AUTH_RE.test(message) && (code !== 0 || out?.is_error)) {
        return reject(new ClaudeAuthError(`claude: потрібен вхід — ${message.slice(0, 300)}`));
      }
      if (LIMIT_RE.test(message) && (code !== 0 || out?.is_error)) {
        return reject(new ClaudeLimitError(`claude: ліміт — ${message.slice(0, 300)}`));
      }
      if (code !== 0 || !out || out.is_error || typeof out.result !== 'string') {
        return reject(new ClaudeError(`claude (код ${code}, ${out?.subtype ?? '-'}): ${message.slice(0, 500)}`));
      }
      resolve({ result: out.result, usage: formatUsage(out) });
    });

    // Процес може впасти раніше, ніж дочитає великий stdin з фото — помилку запису обробить 'close'
    child.stdin.on('error', () => {});
    child.stdin.end(buildUserMessage(prompt, opts.images));
  });
}

/** Дістає JSON-об'єкт з відповіді моделі (терпить ```json-обгортку і текст навколо). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('у відповіді немає JSON-об\'єкта');
  return JSON.parse(body.slice(start, end + 1));
}

/** Виклик з валідацією через zod; при невалідному JSON — 1 повтор із поясненням помилки. */
export async function askJson<T extends z.ZodType>(prompt: string, schema: T, opts: ClaudeOptions): Promise<z.infer<T>> {
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const fullPrompt =
      attempt === 1
        ? prompt
        : `${prompt}\n\n---\nYour previous response was invalid: ${lastError}\nReturn ONLY valid JSON matching the schema, with no text around it.`;
    const raw = await runClaude(fullPrompt, opts);
    try {
      const parsed = schema.safeParse(extractJson(raw));
      if (parsed.success) return parsed.data;
      lastError = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
    } catch (err) {
      lastError = (err as Error).message;
    }
    if (attempt === 1) opts.log?.(`↻ Claude: ${opts.tag ?? 'запит'} — невалідна відповідь (${lastError.slice(0, 120)}), повтор`);
  }
  throw new ClaudeError(`невалідний JSON після повтору: ${lastError}`);
}
