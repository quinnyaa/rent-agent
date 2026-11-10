#!/usr/bin/env node
// Фейковий `claude -p --input-format stream-json` для тестів: рахує одночасні процеси, повертає аргументи у result
import { appendFileSync } from 'node:fs';
const log = process.env.FAKE_CLAUDE_LOG;
let input = '';
for await (const chunk of process.stdin) input += chunk;
appendFileSync(log, `start ${Date.now()}\n`);
await new Promise((r) => setTimeout(r, 200));
appendFileSync(log, `end ${Date.now()}\n`);
const args = process.argv.slice(2);
// Повідомлення stream-json: { type: 'user', message: { content: [...] } }
const content = JSON.parse(input).message.content;
const prompt = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const say = (obj) => console.log(JSON.stringify(obj));
say({ type: 'system', subtype: 'init' });
// Прострочений вхід: саме так відповідає справжній CLI (перевірка через промпт або env FAKE_CLAUDE_FAIL=auth)
if (prompt.includes('AUTHFAIL') || process.env.FAKE_CLAUDE_FAIL === 'auth') {
  say({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.' });
  process.exit(1);
}
if (prompt.includes('LIMIT')) {
  say({ type: 'result', is_error: true, result: 'Claude AI usage limit reached' });
  process.exit(1);
}
const result = {
  args,
  hasKey: !!process.env.ANTHROPIC_API_KEY,
  thinking: process.env.MAX_THINKING_TOKENS ?? null,
  blocks: content.map((b) => b.type),
};
say({
  type: 'result',
  is_error: false,
  num_turns: 1,
  total_cost_usd: 0.01,
  modelUsage: { haiku: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
  result: '```json\n' + JSON.stringify(result) + '\n```',
});
