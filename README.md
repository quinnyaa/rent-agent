# rent-agent

A personal apartment-hunting agent for Slovakia. Once an hour it checks the rental search on
[reality.bazos.sk](https://reality.bazos.sk), has Claude read every new listing (text first, then all the photos)
against your own requirements, and sends the ones that fit to Telegram.

- **Runs locally on your Mac.** Scheduled with launchd, with an optional menu-bar icon (SwiftBar).
- **Uses your Claude subscription, not the API.** Analysis goes through the Claude Code CLI (`claude -p`). No API key is
  needed, and the agent strips `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the child process so it can never bill the API.
- **The AI does the filtering.** There are no keyword filters in the code — you describe what you want in plain text
  in `criteria.md`.
- **Polite to the site.** Requests go strictly one at a time with 2–5 s pauses.

> **Language note.** Telegram messages, logs and code comments are in **Ukrainian** (the author's language); listings
> are in Slovak; prompts and criteria are in English. To get messages in another language, see
> [Make it yours](#make-it-yours).

> **Disclaimer.** This is a personal tool, not affiliated with bazos.sk. It reads public search pages the way a browser
> would. Use it only for your own apartment search, don't increase the request rate, and respect the site's terms.
> Everything it collects (database, photos, shortlist) is stored on your machine.

> **What leaves your machine.** The files are stored locally, but the analysis is not offline: the text and photos of
> every analyzed listing, together with your `criteria.md`, are sent to Anthropic through the Claude Code CLI (under
> your subscription's data settings), and matching listings (text summary, link, photos) are sent to your Telegram
> chat. `--dry-run` only skips Telegram — it still fetches pages and calls Claude. Nothing else is sent anywhere.
> To wipe the local data, delete the `data/` folder and `shortlist.md`.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration (`.env`)](#configuration-env)
- [Make it yours](#make-it-yours)
- [Running](#running)
- [Run it every hour (launchd)](#run-it-every-hour-launchd)
- [Menu-bar icon (SwiftBar)](#menu-bar-icon-swiftbar)
- [How it works](#how-it-works)
- [What you get in Telegram](#what-you-get-in-telegram)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Requirements

- **macOS** for the hourly schedule and the menu-bar icon. The agent itself (`npm run once`) runs anywhere Node and
  `claude` do.
- **Node.js ≥ 22.13** (uses the built-in `node:sqlite`; no build step, TypeScript runs through `tsx`).
- **[Claude Code CLI](https://claude.com/claude-code)** logged in to a Claude subscription: `claude auth login`.
- **A Telegram bot** (optional — without it results are printed to the console).

## Quick start

```bash
git clone https://github.com/quinnyaa/rent-agent.git
cd rent-agent
npm install
cp .env.example .env                  # then fill in the Telegram values (see below)
cp criteria.example.md criteria.md    # then describe the apartment you want
npm test
npm run once -- --dry-run --limit 3   # trial run: 3 listings, nothing sent to Telegram
```

If the trial run prints verdicts for three listings, everything works. Then:

```bash
npm run once               # a real run: sends matches to Telegram
npm run schedule:install   # run automatically every 60 minutes
```

**Setting up the Telegram bot**

1. Talk to [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token into `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy `message.chat.id` into
   `TELEGRAM_CHAT_ID`. (For a group: add the bot to the group, write something there, and use the group's negative id.)

**About the first run.** A search can return 150+ listings. On the first run only the newest `FIRST_RUN_LIMIT` (40) are
analyzed; the rest are marked `skipped_initial`, so you are not flooded and your subscription limit is not burned at once.
From then on only new listings and listings whose price changed are analyzed.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | — | Chat to send to (see above) |
| `CLAUDE_MODEL` | `haiku` | Model for **photo** analysis: `haiku`, `sonnet` (more attentive, costs more of your limit) or `opus`. Text analysis always uses `sonnet` |
| `PHOTO_SCORE_MIN` | `5` | Minimum photo score (1–10) for a listing to be sent |
| `FIRST_RUN_LIMIT` | `40` | How many listings to analyze on the very first run |
| `HEARTBEAT_HOUR` | `20` | After this hour (0–23) a daily "still alive" report is sent |
| `CLAUDE_PARALLEL` | `4` | Concurrent `claude` calls. Site requests are still strictly sequential |
| `CITY` | `poprad` | Which city from `src/cities.ts` to search (same as `--city`) |
| `DATA_DIR` | `data` | Alternative folder for the database and photos (handy for experiments) |

## Make it yours

The repository ships with the author's setup (Poprad, up to €750). These are the things to change:

| What | Where | Notes |
|---|---|---|
| Apartment requirements | `criteria.md` | Your personal file (gitignored). Plain text, re-read on every run. Replace the price cap, the wishes and the `[TODO: …]` lines. If the file is missing, `criteria.example.md` is used |
| City, radius, price range | `src/cities.ts` | See below |
| Default city | `DEFAULT_CITY` in `src/cities.ts`, or `--city <key>` / `CITY` in `.env` | |
| Bot token, thresholds, model | `.env` | Gitignored |
| Schedule interval | `bash scripts/schedule.sh install <minutes>` | 60 by default |
| launchd job name | `LABEL` in `scripts/schedule.sh` **and** `scripts/swiftbar/rent-agent.1m.sh` | `com.rentagent.poprad`. No need to change it; if you do, run `npm run schedule:uninstall` first |
| Message language | `prompts/*.md` and the strings in `src/telegram.ts`, `src/run.ts` | The prompts ask the model to answer in Ukrainian — change that instruction for another language |
| Another listings site | `src/sources/` | See [Development](#development) |

**Adding your city.** Open reality.bazos.sk, pick *Prenájom → Byty*, set the location, radius and price, and search.
Copy these parameters from the address bar into a new entry in `src/cities.ts`:

```ts
zilina: {
  key: 'zilina',
  name: 'Žilina',                 // goes into the prompt as {{city}}
  bazosQuery: '?hledat=&hlokalita=01001&humkreis=5&cenaod=&cenado=700&order=',
},
```

`hlokalita` is the postal code, `humkreis` the radius in km, `cenaod` / `cenado` the price range. Keep **only** these
six parameters, in this order — extra ones from the browser URL (`rubriky`, `Submit`, `crp`, `kitx`) break pagination.
Keep the price cap consistent with `criteria.md`.

**Files that stay on your machine** (gitignored): `.env`, `criteria.md`, `shortlist.md`, `data/` (database, photos,
logs), `.claude/settings.local.json`.

## Running

```bash
npm run once                              # one run
npm run once -- --dry-run                 # no Telegram: messages are printed to the console
npm run once -- --limit 5                 # process at most 5 listings
npm run once -- --model sonnet            # another model for photos
npm run once -- --city kosice             # another city (poprad | kosice | mikulas | bratislava)
npm run once -- --city kosice --digest    # no per-listing messages: only a summary with the top 10
npm run once -- --recheck 195366854,196650963   # re-analyze these listings from the database
npm run sync                              # normal run + remove listings that disappeared from the site
npm run sync -- --dry-run --limit 0       # only show what would be removed
```

A real run (`npm run once` without `--dry-run`) sends Telegram messages and uses your subscription limit.
To experiment without touching your real database:

```bash
DATA_DIR=/tmp/rent-test npm run once -- --dry-run --limit 3
```

If you use Claude Code, the repository also includes a subagent (`.claude/agents/rent-city-scan.md`) for a one-off scan
of a city: ask Claude Code something like "analyze all apartments in Liptovský Mikuláš and send only the top 10".

## Run it every hour (launchd)

```bash
npm run schedule:install          # install and enable (every 60 min, and right after login)
bash scripts/schedule.sh install 30   # a different interval, in minutes
npm run schedule:status           # enabled / disabled / not installed, interval, last exit code
npm run schedule:run-now          # run now, outside the schedule
npm run schedule:disable          # pause; survives reboots
npm run schedule:enable           # resume
npm run schedule:sync             # a run with site sync, in the background
npm run schedule:uninstall        # remove completely
```

- No API key is involved: `claude` takes the subscription login from the macOS Keychain, which the launchd job can read
  because it runs in your user session.
- If the Mac was asleep, missed runs do not pile up — there is one run after wake-up.
- Logs are written per day to `data/logs/YYYY-MM-DD.log` and kept for 30 days. launchd's own errors go to
  `data/logs/launchd.err.log`.
- A lock file prevents overlapping runs.
- If you move the project folder, run `npm run schedule:install` again — the path is stored in
  `~/Library/LaunchAgents/com.rentagent.poprad.plist`.

### Site sync (`--sync`)

The hourly run only sees what is in the search results, so listings that vanished from the site would stay in the
database. A sync run (`npm run sync`, `npm run schedule:sync`, or the menu-bar button) does a normal run and then checks
every stored listing that was not in the search with a HEAD request. Gone → removed from the database together with its
photos. Still reachable, or could not be checked → kept. It is manual on purpose and is skipped if the search itself
failed.

## Menu-bar icon (SwiftBar)

```bash
brew install --cask swiftbar
PD="$HOME/Library/Application Support/SwiftBar/Plugins"
mkdir -p "$PD"
ln -sfn "$PWD/scripts/swiftbar/rent-agent.1m.sh" "$PD/rent-agent.1m.sh"
defaults write com.ameba.SwiftBar PluginDirectory "$PD"
open -a SwiftBar
```

- The plugin folder is separate because SwiftBar runs every file in it; it holds only a symlink to the script.
- To keep the icon after a reboot, enable SwiftBar → Preferences → General → "Launch at login".
- Icons: ⏳ a run is in progress · ⏸ schedule disabled or not installed · 🔑 Claude is not logged in (the menu offers a
  login button that opens `claude auth login` in a terminal) · ⚠️ the last run had errors · 🏠 all good, waiting.
- The menu shows the schedule state, the last run, today's totals, and buttons to run now, sync with the site, and
  enable/disable the schedule, plus links to the log, the shortlist and the project folder. Menu labels are in Ukrainian.

## How it works

1. **Collect.** Walks all search pages and de-duplicates by listing id. New listings and listings with a changed price
   go to processing; for the rest only `last_seen` is updated.
2. **Text.** Opens the listing page and sends the full description to `claude -p` together with `criteria.md`
   (`prompts/text.md`). The model first checks each must-have requirement, then gives a verdict: `yes`, `maybe` or `no`.
   When in doubt it must answer `maybe`, not `no` — missing a good apartment is worse than looking at an extra one.
3. **Photos.** For `yes` / `maybe`, downloads all photos (up to 20) to `data/photos/` and sends **all** of them to the
   model in a single message (`prompts/photos.md`). Listings without photos are rejected.
4. **Deliver.** If the photo score is ≥ `PHOTO_SCORE_MIN`, the listing is sent to Telegram (the 5 best photos plus a
   caption) and appended to `shortlist.md`.

Listings are processed concurrently, but all site requests share one sequential queue (pages 2–5 s apart, photos
0.5–1 s apart) and at most `CLAUDE_PARALLEL` Claude calls run at once. The log shows tokens and an approximate cost for
every call. If the subscription limit is hit, processing stops and unfinished listings are picked up by the next run.

State lives in SQLite (`data/rent.db`, table `listings`):

| Status | Meaning |
|---|---|
| `new` | not processed yet |
| `pending_analysis` | an error or a Claude/site limit; retried on the next run (up to 5 attempts) |
| `rejected` | does not fit; the reason is in `reject_reason` |
| `matched` | fits but not sent yet (dry run or Telegram failure); sent by the next normal run |
| `notified` | sent |
| `skipped_initial` | skipped on the first run |

Listings that no longer open on the site are deleted from the database together with their photos.

## What you get in Telegram

- **A message per matching apartment**: photos and a caption with the price, a block of facts (heating, floor heating,
  dishwasher, washing machine, furniture, air conditioning, balcony, floor, parking — "not stated" when unknown) and
  pros/cons.
- **A summary after every run that analyzed something**: how many were analyzed, matched, rejected and postponed, with a
  reason for the postponed ones. If nothing new appeared, a short "no new apartments" note.
- **Top 10** of the matching apartments that are still online, ranked by fit and photo score. Each candidate is
  re-checked before sending; apartments appearing in the top for the first time are marked **NEW**.
- **Alerts** (at most once per 6 hours per type): the search returned nothing, the parser crashed, several listing pages
  failed to parse, or the Claude CLI login expired (`claude auth login` fixes it).
- **A daily heartbeat** with the day's totals, so you know the agent is alive.

## Troubleshooting

| Symptom | What to do |
|---|---|
| "🔑" in the menu bar / an auth alert in Telegram | The Claude CLI login expired: run `claude auth login` |
| Listings stay `pending_analysis` | Usually the subscription limit; they are retried on the next run. The reason is in the Telegram summary and in `data/logs/` |
| Nothing arrives in Telegram | Check `.env`; try `npm run once -- --dry-run --limit 3` and read the output |
| The search returns 0 listings / the parser fails | bazos may have changed its markup — see [Development](#development) |
| A run seems stuck | The lock is released automatically when the process is dead; manually: `rm data/run.lock` |
| You changed `criteria.md` and want old listings re-evaluated | Put them back in the queue (below) |

Useful queries:

```bash
# what is in the database
sqlite3 -header -column data/rent.db "SELECT status, COUNT(*) FROM listings GROUP BY status"
sqlite3 -header -column data/rent.db "SELECT id, title, price, status, reject_reason FROM listings ORDER BY last_seen DESC LIMIT 20"
sqlite3 -header -column data/rent.db "SELECT * FROM runs ORDER BY id DESC LIMIT 10"

# the model's full answer for one listing
sqlite3 data/rent.db "SELECT text_result_json FROM listings WHERE id='196497972'" | jq

# re-evaluate one listing, or everything rejected by the text step
sqlite3 data/rent.db "UPDATE listings SET status='new', attempts=0 WHERE id='196497972'"
sqlite3 data/rent.db "UPDATE listings SET status='new', attempts=0 WHERE status='rejected' AND reject_reason LIKE 'текст:%'"
```

(`reject_reason` values are in Ukrainian: `текст:` = rejected by text, `фото N/10` = by photos, `немає фото` = no photos.)

## Development

```bash
npm test            # vitest: parser on saved HTML, pipeline logic, the claude wrapper with a fake CLI
npm run typecheck   # tsc --noEmit
```

- `CLAUDE.md` describes the code structure and the invariants that must not be broken (in Ukrainian).
- **bazos changed its markup:** save fresh HTML into `fixtures/` (replace seller names and phone numbers with
  placeholders first), compare with `docs/source-bazos.md`, fix `src/sources/bazos.ts`, update `tests/bazos.test.ts`.
- **A new listings site:** create `src/sources/<name>.ts` implementing `SourceAdapter` (`src/sources/types.ts`) and
  register it in `src/sources/index.ts`. All site requests must go through `src/http.ts`.
- **Backfill** of newer extracted fields for old listings: `npm run backfill:extras` (`--dry-run`, `--force`).

## License

[MIT](LICENSE). The HTML files in `fixtures/` are saved pages of reality.bazos.sk used only as parser test data; seller
contact details in them are replaced with placeholders.
