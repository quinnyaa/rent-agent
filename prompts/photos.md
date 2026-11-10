You are helping me choose an apartment to rent in {{city}} (Slovakia).
Above are all {{photo_count}} photos from the listing, numbered from 1 in the order shown.
Look at every single photo before answering: a room is often shown only once, near the end of the set.

# About the apartment (from the listing text)

{{listing_summary}}

# My requirements

{{criteria}}

# What to assess

- `score` 1–10 — overall impression of the apartment in the photos, given my requirements.
- `renovation` — state of renovation (new / after reconstruction / old / needs renovation).
- `kitchen`, `bathroom`, `windows` (plastic/wooden, condition), `light` (how bright), `furniture`
  (how furnished, condition of the furniture) — briefly. Base each one on all the photos that show it.
  Write "не видно на фото" only after checking every photo and finding none that shows it.
- `red_flags` — up to ~80 characters each; anything concerning: damp/mould, very old condition, photos of a different apartment,
  stock/rendered photos, only facade photos, mismatch with the text (e.g. the text says "furnished" but the rooms are empty).
  A missing room (no bathroom / kitchen / bedroom photo) is a red flag only if none of the {{photo_count}} photos shows it.
- `photos_look_real` — `false` if the photos look like stock images, renders, or clearly of another place.
- `seen` — things clearly visible in at least one photo: `dishwasher` (built-in ones count: an open door with racks,
  a control panel on the door edge), `washing_machine`, `air_conditioning` (indoor unit on a wall), `balcony` (balcony / loggia / terrace).
  `true` only if you actually see it; otherwise `null`. Never guess, never `false` — not being in a photo doesn't mean it's absent.
- `summary_uk` — 1–2 sentences.
- `best_photos` — numbers of the 4–5 photos that best show the apartment
  (rooms, kitchen, bathroom; not the facade or the floor plan if there are better ones).

# Language

Write all string values (`renovation`, `kitchen`, `bathroom`, `windows`, `light`, `furniture`, `red_flags`, `summary_uk`) in Ukrainian.
Follow the Ukrainian quality rules from the system prompt: natural literary Ukrainian, no surzhyk, no Russian or Slovak calques.

# Response format

Return ONLY the JSON object, with no explanations and no markdown:

{
  "score": 1-10,
  "renovation": string,
  "kitchen": string,
  "bathroom": string,
  "windows": string,
  "light": string,
  "furniture": string,
  "red_flags": string[],
  "photos_look_real": boolean,
  "seen": { "dishwasher": true | null, "washing_machine": true | null, "air_conditioning": true | null, "balcony": true | null },
  "summary_uk": string,
  "best_photos": number[]
}
