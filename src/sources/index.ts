import { bazos } from './bazos.ts';
import type { SourceAdapter } from './types.ts';

// Нові джерела (nehnutelnosti.sk тощо) — додати адаптер сюди
export const sources: SourceAdapter[] = [bazos];
