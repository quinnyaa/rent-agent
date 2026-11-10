import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const logFile = join(mkdtempSync(join(tmpdir(), 'fake-claude-')), 'log');
let claude: typeof import('../src/claude.ts');

beforeAll(async () => {
  process.env.CLAUDE_BIN = new URL('./bin/fake-claude.mjs', import.meta.url).pathname;
  process.env.CLAUDE_PARALLEL = '4';
  process.env.FAKE_CLAUDE_LOG = logFile;
  process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
  claude = await import('../src/claude.ts');
});

/** Максимум одночасних процесів за логом start/end. */
function maxConcurrent(): number {
  const events = readFileSync(logFile, 'utf-8').trim().split('\n').map((l) => l.split(' '));
  let cur = 0, max = 0;
  for (const [kind] of events.sort((a, b) => Number(a[1]) - Number(b[1]))) {
    cur += kind === 'start' ? 1 : -1;
    max = Math.max(max, cur);
  }
  return max;
}

describe('runClaude', () => {
  it('передає модель, effort, системний промпт і прибирає ANTHROPIC_API_KEY', async () => {
    const raw = await claude.runClaude('hi', { model: 'haiku', effort: 'low' });
    const out = claude.extractJson(raw) as { args: string[]; hasKey: boolean };
    expect(out.hasKey).toBe(false);
    expect(out.args).toEqual(expect.arrayContaining(['-p', '--model', 'haiku', '--effort', 'low', '--system-prompt']));
    expect(out.args[out.args.indexOf('--tools') + 1]).toBe('');
    // без цього CLAUDE.md проєкту додається до кожного виклику
    expect(out.args[out.args.indexOf('--setting-sources') + 1]).toBe('');
  });

  it('фото йдуть у тому ж повідомленні перед текстом, thinking:false вимикає роздуми', async () => {
    const raw = await claude.runClaude('hi', { model: 'sonnet', images: ['AAAA', 'BBBB'], thinking: false });
    const out = claude.extractJson(raw) as { args: string[]; thinking: string | null; blocks: string[] };
    expect(out.blocks).toEqual(['text', 'image', 'text', 'image', 'text']);
    expect(out.thinking).toBe('0');
    expect(out.args).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--output-format', 'stream-json']));
  });

  it('без thinking:false роздуми не чіпаються', async () => {
    const out = claude.extractJson(await claude.runClaude('hi', { model: 'sonnet' })) as { thinking: string | null };
    expect(out.thinking).toBeNull();
  });

  it('formatUsage рахує токени з modelUsage', () => {
    expect(
      claude.formatUsage({
        num_turns: 1,
        total_cost_usd: 0.0123,
        modelUsage: { a: { inputTokens: 100, cacheReadInputTokens: 50, outputTokens: 10 }, b: { inputTokens: 5, outputTokens: 1 } },
      }),
    ).toBe('вхід 155 (кеш 50), вихід 11, ходів 1, ≈$0.0123');
  });

  it('не більше 4 процесів одночасно', async () => {
    await Promise.all(Array.from({ length: 10 }, () => claude.runClaude('hi', { model: 'sonnet' })));
    expect(maxConcurrent()).toBe(4);
  });

  it('після ліміту нові виклики не запускаються', async () => {
    await expect(claude.runClaude('LIMIT', { model: 'sonnet' })).rejects.toBeInstanceOf(claude.ClaudeLimitError);
    expect(claude.claudeLimitHit()).toBe(true);
    const before = readFileSync(logFile, 'utf-8').length;
    await expect(claude.runClaude('hi', { model: 'sonnet' })).rejects.toThrow(/пропущено/);
    expect(readFileSync(logFile, 'utf-8').length).toBe(before);
  });
});
