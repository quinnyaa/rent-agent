/**
 * Ціле число з env або аргументу в межах [min, max]. Порожнє значення → типове; сміття чи число поза межами —
 * попередження і типове: NaN у порівняннях мовчки вимикає ліміти (семафор Claude, поріг оцінки фото).
 */
export function intSetting(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= min && value <= max) return value;
  console.warn(`${name}=${JSON.stringify(raw)} — очікується ціле число від ${min} до ${max}; беру ${fallback}`);
  return fallback;
}

export const envInt = (name: string, fallback: number, min: number, max: number) =>
  intSetting(name, process.env[name], fallback, min, max);
