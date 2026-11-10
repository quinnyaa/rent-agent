import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from '../src/http.ts';

const logFile = join(mkdtempSync(join(tmpdir(), 'fake-claude-')), 'log');
let claude: typeof import('../src/claude.ts');
let problems: typeof import('../src/problems.ts');

beforeAll(async () => {
  process.env.CLAUDE_BIN = new URL('./bin/fake-claude.mjs', import.meta.url).pathname;
  process.env.FAKE_CLAUDE_LOG = logFile;
  claude = await import('../src/claude.ts');
  problems = await import('../src/problems.ts');
});

describe('describeProblem', () => {
  it('сторінка: блокування, недоступність, мережа, парсер', () => {
    const d = (err: unknown) => problems.describeProblem('сторінка', err);
    expect(d(new HttpError(429, 'u'))).toBe('bazos блокує запити (HTTP 429)');
    expect(d(new HttpError(503, 'u'))).toBe('bazos недоступний (HTTP 503)');
    expect(d(new TypeError('fetch failed'))).toBe('немає зв’язку з bazos (мережа/тайм-аут)');
    expect(d(new Error('не знайдено опис'))).toBe('сторінка не розпарсилась: не знайдено опис');
  });

  it('Claude: ліміт, запуск, тайм-аут, невалідний JSON, перевантаження, інше', () => {
    const d = (err: unknown) => problems.describeProblem('текст', err);
    expect(d(new claude.ClaudeLimitError('claude: ліміт — usage limit reached'))).toBe('ліміт підписки Claude вичерпано');
    expect(d(new claude.ClaudeError('claude не запустився: spawn claude ENOENT'))).toMatch(/не запустився/);
    expect(d(new claude.ClaudeError('claude: тайм-аут 300000 мс'))).toBe('Claude не відповів вчасно (текст)');
    expect(d(new claude.ClaudeError('невалідний JSON після повтору: verdict: Required'))).toBe('Claude повернув невалідну відповідь (текст)');
    expect(d(new claude.ClaudeError('claude (код 1, success): API Error: 529 Overloaded'))).toBe('сервери Claude перевантажені або недоступні');
    expect(d(new claude.ClaudeError('claude (код 1, -): щось дивне'))).toBe('помилка Claude (текст): claude (код 1, -): щось дивне');
  });

  it('однакові причини групуються, найчастіші першими', () => {
    expect(problems.problemLines(new Map([['а', 1], ['б', 3]]))).toEqual(['   • б: 3', '   • а: 1']);
  });
});

describe('прострочений вхід у Claude CLI', () => {
  it('дає ClaudeAuthError, зупиняє нові виклики і має зрозумілу причину', async () => {
    expect(claude.claudeSucceeded()).toBe(false);
    const err = await claude.runClaude('AUTHFAIL', { model: 'haiku' }).catch((e) => e);
    expect(err).toBeInstanceOf(claude.ClaudeAuthError);
    // Як і ліміт: не вина оголошення, спроби не рахуються
    expect(err).toBeInstanceOf(claude.ClaudeLimitError);
    expect(claude.claudeAuthFailed()).toBe(true);
    expect(problems.describeProblem('текст', err)).toBe(problems.AUTH_HINT);

    const before = readFileSync(logFile, 'utf-8').length;
    await expect(claude.runClaude('hi', { model: 'haiku' })).rejects.toThrow(/пропущено/);
    expect(readFileSync(logFile, 'utf-8').length).toBe(before);
  });
});
