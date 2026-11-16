import type { ListingRow } from './db.ts';
import type { Listing } from './sources/types.ts';

/**
 * Дублікати між сайтами: агенції публікують ту саму квартиру і на bazos, і на nehnutelnosti.
 * Дублікатом вважається лише безсумнівний випадок — та сама ціна і той самий текст оголошення
 * (з точністю до пробілів, регістру, діакритики й контактів). Будь-який сумнів → не дублікат, аналізуємо як звичайне.
 */

/** Коротший текст («Prenajmem 2-izbový byt, volať…») може збігтися в різних квартир. */
export const MIN_FINGERPRINT = 200;

/** Відбиток вільного тексту оголошення: лише літери й цифри, без контактів і без блоку «Parametre:». */
export function textFingerprint(description: string): string {
  return description
    .replace(/^Parametre:\n(?:- .*\n?)*/, '')
    // nehnutelnosti ховає телефони/e-mail за заглушкою, bazos показує — прибираємо і те, і те
    .replace(/\[kontakt skrytý\]/g, ' ')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ' ')
    .replace(/(?:\+|00)?\d(?:[ \/().-]?\d){8,}/g, ' ')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Двійник оголошення серед кандидатів з інших джерел (та сама ціна, вже з вердиктом — відбирає Db.twinCandidates).
 * null — двійника немає або певності немає.
 */
export function findTwin(listing: Pick<Listing, 'source' | 'price' | 'description'>, candidates: ListingRow[]): ListingRow | null {
  if (listing.price === null) return null;
  const fp = textFingerprint(listing.description);
  if (fp.length < MIN_FINGERPRINT) return null;
  return (
    candidates.find(
      (c) => c.source !== listing.source && c.price === listing.price && !!c.raw_text && textFingerprint(c.raw_text) === fp,
    ) ?? null
  );
}

/**
 * Що робити з дублікатом залежно від долі двійника:
 * - 'matched' — двійник підійшов (користувач його вже отримав або отримає) → беремо його оцінки, окремо не шлемо;
 * - 'rejected' — двійник відхилено за текстом → той самий текст дасть той самий вердикт;
 * - null — двійника відхилено за фото / без фото (на іншому сайті фото можуть бути інші) → аналізуємо як звичайне.
 */
export function twinOutcome(twin: ListingRow): 'matched' | 'rejected' | null {
  if ((twin.status === 'matched' || twin.status === 'notified') && twin.text_result_json && twin.photo_result_json) return 'matched';
  if (twin.status === 'rejected' && twin.text_result_json && twin.reject_reason?.startsWith('текст:')) return 'rejected';
  return null;
}

export const DUPLICATE_PREFIX = 'дублікат';
/** Позначка в reject_reason: «дублікат bazos:197391295». */
export const duplicateNote = (twin: Pick<ListingRow, 'source' | 'id'>) => `${DUPLICATE_PREFIX} ${twin.source}:${twin.id}`;
/** Чи це примітка про дублікат (сама або після «текст: »), а не звичайна причина відмови. */
export const isDuplicateNote = (reason: string | null | undefined) => !!reason && /^(?:текст: )?дублікат [\w-]+:[\w-]+/.test(reason);
