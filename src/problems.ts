import { ClaudeAuthError, ClaudeLimitError } from './claude.ts';
import { BlockedError, HttpError } from './http.ts';

/** Що робити, коли CLI не авторизований — один текст для підсумку, алерта і логу. */
export const AUTH_HINT = 'Claude не авторизований — виконай на Mac: claude auth login';

const NETWORK_RE = /ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|getaddrinfo|fetch failed|socket hang up|network|connection error/i;
const OVERLOAD_RE = /overloaded|API Error: 5\d\d|\b(500|502|503|504|529)\b|internal server error|service unavailable/i;

const short = (message: string) => message.replace(/\s+/g, ' ').trim().slice(0, 90);

/**
 * Коротка причина, чому оголошення лишилось необробленим, — для підсумку в Telegram.
 * Однакові причини мають давати однаковий рядок: за ним вони групуються й рахуються.
 */
export function describeProblem(stage: 'сторінка' | 'текст' | 'фото', err: unknown): string {
  const message = (err as Error)?.message ?? String(err);

  if (stage === 'сторінка') {
    if (err instanceof HttpError) {
      if (err.status === 403 || err.status === 429) return `bazos блокує запити (HTTP ${err.status})`;
      if (err.status >= 500) return `bazos недоступний (HTTP ${err.status})`;
      return `bazos: HTTP ${err.status}`;
    }
    if (err instanceof BlockedError) return 'bazos: адреса поза сайтом або завелика відповідь';
    if (NETWORK_RE.test(message) || /timeout|aborted/i.test(message)) return 'немає зв’язку з bazos (мережа/тайм-аут)';
    return `сторінка не розпарсилась: ${short(message)}`;
  }

  if (err instanceof ClaudeAuthError) return AUTH_HINT;
  if (err instanceof ClaudeLimitError) return 'ліміт підписки Claude вичерпано';
  if (/не запустився/.test(message)) return 'claude CLI не запустився (не встановлений або не в PATH)';
  if (/тайм-аут/.test(message)) return `Claude не відповів вчасно (${stage})`;
  if (/невалідний JSON/.test(message)) return `Claude повернув невалідну відповідь (${stage})`;
  if (OVERLOAD_RE.test(message)) return 'сервери Claude перевантажені або недоступні';
  if (NETWORK_RE.test(message)) return 'немає зв’язку з Claude (мережа)';
  return `помилка Claude (${stage}): ${short(message)}`;
}

/** Рядки «• причина: N» для підсумку, найчастіші першими. */
export function problemLines(problems: Map<string, number>): string[] {
  return [...problems.entries()].sort((a, b) => b[1] - a[1]).map(([reason, n]) => `   • ${reason}: ${n}`);
}
