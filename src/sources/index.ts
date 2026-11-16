import type { City } from '../cities.ts';
import { bazos } from './bazos.ts';
import { nehnutelnosti } from './nehnutelnosti.ts';
import type { SourceAdapter } from './types.ts';

// Нове джерело — додати адаптер сюди (і його домени в ALLOWED_DOMAINS у src/http.ts)
export const sources: SourceAdapter[] = [bazos, nehnutelnosti];

/**
 * Джерела, налаштовані для міста. Джерело без пошуку для цього міста пропускається повністю:
 * порожній результат пошуку Runner.collect вважає поломкою і шле алерт.
 */
export const sourcesFor = (city: City): SourceAdapter[] => sources.filter((s) => s.supports?.(city) ?? true);
