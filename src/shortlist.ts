import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import type { PhotoResult, TextResult } from './analyze/schemas.ts';
import type { ListingRow } from './db.ts';

export function appendShortlist(path: string, row: ListingRow, text: TextResult, photo: PhotoResult, caption: string) {
  if (!existsSync(path)) writeFileSync(path, '# Shortlist\n\nПідхожі оголошення, надіслані в Telegram.\n');
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const lines = [
    '',
    `## [${row.title}](${row.url})`,
    '',
    `- Додано: ${date} · ${row.source} #${row.id} · Текст ${text.score}/10 (${text.verdict}) · Фото ${photo.score}/10`,
    `- ${text.summary_uk}`,
    `- Фото: ${photo.summary_uk}`,
    '',
    '```',
    caption,
    '```',
    '',
  ];
  appendFileSync(path, lines.join('\n'));
}
