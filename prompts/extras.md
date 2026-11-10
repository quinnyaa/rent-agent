Below is an apartment rental listing from {{city}} (Slovakia), in Slovak. Extract these facts about the apartment:

- `dishwasher` (umývačka riadu, umývačka, myčka), `floor_heating` (podlahové kúrenie / vykurovanie, podlahovka), `washing_machine` (práčka, práčka so sušičkou),
  `balcony` (balkón, loggia, lodžia, terasa): `true` if the text mentions it in the apartment; `false` only if the
  text explicitly says there is none; `null` if not mentioned. Careful: "umývadlo" is a washbasin, not a dishwasher.
  `floor_heating`: Only underfloor heating counts; NOT: "plávajúca podlaha" (floating floor), wall heating (stenové vykurovanie),
  generic or electric heating (kúrenie, elektrické kúrenie, "vrátane kúrenia") — those are `null`.
- `parking`: short, in Ukrainian, e.g. "власне місце", "гараж", "на вулиці", "за доплату 50 €"; `null` if not mentioned.
- `evidence`: the exact Slovak phrases you based it on (quoted, not translated), or an empty string.

Title: {{title}}

Description:
"""
{{description}}
"""

Return ONLY the JSON object, with no explanations and no markdown:

{ "dishwasher": true | false | null, "floor_heating": true | false | null, "washing_machine": true | false | null, "balcony": true | false | null,
  "parking": string | null, "evidence": string }
