You are helping me find an apartment to rent in {{city}} (Slovakia).
Evaluate the listing below against my requirements. The listing is in Slovak — read it carefully; all information is only in the free text.

# My requirements

{{criteria}}

# Listing

Source: {{source}}
URL: {{url}}
Title: {{title}}
Listed price: {{price}}
Location: {{location}}
Date: {{date}}
Photos in the listing: {{photo_count}} (they are assessed separately — do not consider photos in this evaluation)
{{price_note}}

Description:
"""
{{description}}
"""

# How to evaluate

- `must_have` — fill this FIRST. One entry per item of the "Must have" section, in the same order:
  `requirement` — the requirement in a few words; `met` — `true` / `false` / `null` (the text doesn't say);
  `evidence` — the concrete fact from the listing you based it on (e.g. "nájomné 480 € vrátane energií", "dlhodobý prenájom, min. 1 rok").
  Compare numbers literally: a distance or price beyond the limit means `met: false`.
  Use `met: false` only when the listing clearly violates the requirement; if it's unclear or ambiguous — `null`.
- `verdict`:
  - `no` — at least one `must_have` entry has `met: false` (e.g. garsónka/studio with the kitchen in the room,
    daily/short-term rental, price clearly over the limit), or it is not an apartment rental offer at all
    (a sale, someone looking for an apartment, a room in a shared flat, etc.).
  - `maybe` — no "Must have" requirement is clearly violated, but important information is missing or there are serious doubts.
  - `yes` — all "Must have" requirements are met.
  - When in doubt between `no` and `maybe`, choose `maybe`: wrongly rejecting a suitable apartment is worse than letting an extra one through.
- `score` 1–10 (integer; 1 is the minimum — never 0, also for `verdict: no`) — how well the apartment suits me, taking into account the "Important" section and the red flags.
- `fit_score` 1–10 — the same, but WITHOUT considering the price: only the apartment itself (rooms, area, furnishing,
  condition, district, the "Important" requirements, red flags). A cheaper apartment must not get a higher `fit_score` just because of the price.
- `reasons` — 2–5 short points (up to ~80 characters each): the main pros and why this verdict.
  Facts like price, heating or appliances are shown separately — don't just repeat them.
- `red_flags` — items from the "Red flags" section and other risks, up to ~80 characters each (empty array if none).
- `extracted` — facts from the text. If the text doesn't say — `null`, don't make things up.
  Euro amounts — as numbers. `total_monthly_eur` = rent + utilities (energies) if both are known (or if utilities are included in the price).
  If utilities are given as a range — use the midpoint and mention it in `reasons`.
  `landlord_type`: "owner" | "agency" | null.
  `dishwasher`: `true` if the text mentions a dishwasher in the apartment (umývačka riadu, umývačka, myčka, …),
  `false` only if the text explicitly says there is none, otherwise `null`. It does not affect `verdict`.
  `floor_heating`: `true` if the text mentions underfloor heating in the apartment (podlahové kúrenie, podlahové vykurovanie,
  podlahovka, …), `false` only if the text explicitly says there is none, otherwise `null`. It does not affect `verdict`.
  Only underfloor heating counts; NOT: "plávajúca podlaha" (floating floor), wall heating (stenové vykurovanie),
  generic or electric heating (kúrenie, elektrické kúrenie, "vrátane kúrenia") — those are `null`.
  `washing_machine` (práčka), `balcony` (balkón, loggia, terasa) — the same rule: `true` / `false` / `null`.
  `parking` — short: e.g. "власне місце", "гараж", "на вулиці", "за доплату 50 €"; `null` if not mentioned.
  `heating` — short, 2–5 words (e.g. "газовий котел", "центральне", "електричне, підлогове"); `null` if the type is not stated.
  `floor` — "3/8" (floor / total floors) or "3" if the total is unknown.
  `district_or_street` — keep the original Slovak spelling (e.g. "Starý Juh", "Levočská").
- `summary_uk` — 2–3 sentences: what kind of apartment it is, where, the total monthly cost, the main caveat.

# Language

Write `must_have` (`requirement`, `evidence`), `reasons`, `red_flags`, `summary_uk` and the string values in `extracted`
(except `district_or_street` and enum values) in Ukrainian.
Follow the Ukrainian quality rules from the system prompt: natural literary Ukrainian, no surzhyk, no Russian or Slovak calques.

# Response format

Return ONLY the JSON object, with no explanations and no markdown:

{
  "must_have": [{ "requirement": string, "met": true | false | null, "evidence": string }],
  "verdict": "yes" | "maybe" | "no",
  "score": 1-10,
  "fit_score": 1-10,
  "reasons": string[],
  "red_flags": string[],
  "extracted": {
    "rooms": number | null, "area_m2": number | null, "rent_eur": number | null, "energies_eur": number | null,
    "total_monthly_eur": number | null, "deposit_eur": number | null, "heating": string | null,
    "air_conditioning": boolean | null, "dishwasher": boolean | null, "floor_heating": boolean | null,
    "washing_machine": boolean | null, "balcony": boolean | null, "parking": string | null,
    "furnished": "yes" | "partly" | "no" | null,
    "district_or_street": string | null, "floor": string | null, "elevator": boolean | null,
    "pets": string | null, "available_from": string | null, "min_term": string | null,
    "landlord_type": "owner" | "agency" | null
  },
  "summary_uk": string
}
