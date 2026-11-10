# CLAUDE.md

Персональний агент пошуку оренди квартири в Попраді (Словаччина). Раз на годину (launchd) обходить пошук на
reality.bazos.sk, кожне нове оголошення аналізує через `claude -p` (спершу текст, потім фото), підхожі шле в Telegram
і дописує в `shortlist.md`. Працює локально на macOS користувача, оплата лише через підписку Claude (не API).

Мова проєкту: **українська** — коментарі в коді, логи, повідомлення в Telegram, документація. Оголошення словацькою.
Виняток: **промпти (`prompts/*.md`) і `criteria.md` — англійською** (менше токенів), але текстові поля відповіді моделі
(`reasons`, `summary_uk`, …) мають бути українською — з них збирається повідомлення в Telegram.
Користувацька документація (налаштування, запуск, дебаг, launchd, SwiftBar) — у `README.md` (**англійською** — публічний репозиторій на GitHub). Тут — те, що потрібно для роботи з кодом.

## Стек і команди

Node.js ≥ 22.13, TypeScript (ESM, запуск через `tsx`, без збірки), `node:sqlite` (вбудований), cheerio, sharp, zod, vitest.
Імпорти між файлами — з розширенням `.ts` (`allowImportingTsExtensions`).

```bash
npm test                                  # vitest: парсер на fixtures, логіка, claude.ts з фейковим CLI
npm run typecheck                         # tsc --noEmit
npm run once -- --dry-run --limit 3       # прогін без Telegram (вивід у консоль)
DATA_DIR=/tmp/rent-test npm run once -- --dry-run --limit 3 --model haiku   # окрема БД, не чіпає основну
```

Реальний прогін (`npm run once` без `--dry-run`) шле повідомлення в Telegram і витрачає ліміт підписки —
не запускати без потреби. Для перевірки змін — тести і `--dry-run` з `DATA_DIR`.

## Структура

```
src/run.ts              точка входу; клас Runner: collect → process → deliver, підсумок, топ-10, алерти, heartbeat
src/sources/types.ts    SourceAdapter, ListingSummary (картка з пошуку), Listing (повне оголошення)
src/sources/bazos.ts    єдине джерело: парсинг пошуку/деталі (cheerio), isAlive через HEAD (видалене → 301 на пошук)
src/sources/index.ts    реєстр джерел — нове джерело додавати сюди
src/analyze/index.ts    analyzeText / analyzePhotos: підставляє criteria.md і дані в шаблони prompts/*.md
src/analyze/schemas.ts  zod-схеми TextResult / PhotoResult (те, що повертає модель і зберігається в БД як JSON)
src/claude.ts           spawn `claude -p`: семафор CLAUDE_PARALLEL, детект ліміту, extractJson, askJson (1 повтор при невалідному JSON)
src/http.ts             ВСІ запити до сайтів через одну послідовну чергу з паузами (сторінки 2–5 с, фото 0.5–1 с), 1 повтор
src/db.ts               SQLite: таблиці listings, runs, meta; статуси й переходи
src/photos.ts           усі фото (до 20) → data/photos/<source>-<id>/01.jpg… (1024 px, для Telegram); encodeForModel → 768 px base64
src/telegram.ts         TelegramNotifier / ConsoleNotifier, buildCaption (≤1024 симв.: блок фактів factLines + плюси/мінуси), pickPhotos, rankTop, formatTop
src/shortlist.ts        дописує підхожі в shortlist.md
src/sync.ts             syncGone / syncLine: звірка --sync (перевірка сторінок оголошень, яких немає в пошуку)
src/problems.ts         describeProblem: коротка причина помилки для підсумку Telegram; AUTH_HINT
src/lock.ts             data/run.lock з PID; застарілий lock знімається автоматично
src/backfill-extras.ts  доаналіз старих raw_text → extracted.dishwasher/floor_heating/washing_machine/balcony/parking (npm run backfill:extras), вердикти не чіпає
prompts/system.md       короткий системний промпт замість стандартного Claude Code
prompts/text.md         шаблон аналізу тексту ({{criteria}}, {{description}}, … )
prompts/photos.md       шаблон аналізу фото (фото передаються в повідомленні перед цим текстом)
prompts/extras.md       шаблон для backfill-extras
criteria.md             вимоги користувача до квартири — читається на кожному запуску; особистий, у .gitignore
criteria.example.md     приклад у репозиторії; береться, якщо criteria.md немає (`criteriaFile` в analyze/index.ts)
scripts/run.sh          обгортка для launchd: PATH, лог у data/logs/YYYY-MM-DD.log, ротація 30 днів
scripts/schedule.sh     керування launchd-агентом com.rentagent.poprad (install/enable/disable/status/run-now); `sync` — run.sh --sync у фоні, повз launchd
scripts/claude-login.sh `claude auth login` для кнопки «Увійти в Claude…» у плагіні
scripts/swiftbar/       плагін рядка меню; читає data/rent.db, data/run.lock і логи
docs/source-bazos.md    опис розмітки bazos (селектори, URL, пагінація) — звіряти при поломці парсера
docs/prompts/           ТЗ-промпти, якими будувалися частини проєкту (історія, не інструкції)
fixtures/               збережений HTML bazos для тестів парсера (імена продавців/телефони замінено заглушками — так само робити з новими)
tests/bin/fake-claude.mjs  фейковий `claude` для тестів (підставляється через CLAUDE_BIN)
data/                   (gitignored) rent.db, photos/, logs/, run.lock
```

## Конвеєр обробки одного оголошення (`Runner.process`)

1. `collect`: пошук → нові оголошення в БД (`new`); у старих оновлюється `last_seen`; зміна `price_text` повертає в
   обробку (`status='new'`, `price_changed=1`). У чергу також ідуть `new`/`pending_analysis` з `attempts < 5`.
   Перший запуск для джерела: лише перші `FIRST_RUN_LIMIT`, решта — `skipped_initial`.
2. `fetchListing` → 404/410 або редирект на пошук (bazos.ts кидає `HttpError(410)`, якщо кінцева URL не `/inzerat/<id>/`)
   = оголошення **видаляється з БД** разом із фото (`removeListing`); інша помилка = `pending_analysis`.
3. Текст: модель **завжди `sonnet`, без роздумів, `effort max`** (константи в `analyze/index.ts`). `verdict=no` → `rejected`.
4. Без фото → `rejected` («немає фото»).
5. Фото: моделі йдуть **усі** фото оголошення (`MAX_PHOTOS = 20` — лише запобіжник), не перші кілька — інакше висновки
   на кшталт «ванна не показана» хибні (вимога користувача). Якщо список URL не змінився і на диску є всі фото —
   береться попередня оцінка без виклику Claude. Модель для фото — `--model` / `CLAUDE_MODEL` (default `haiku`). `score < PHOTO_SCORE_MIN` → `rejected`.
6. `matched` → `deliver` (Telegram + shortlist) → `notified`. Збій Telegram лишає `matched`, наступний запуск дошле.

Усі оголошення обробляються через `Promise.all` одночасно; темп задають черга в `http.ts` і семафор у `claude.ts`.

Статуси: `new | pending_analysis | rejected | matched | notified | skipped_initial | gone` (опис у `src/db.ts`).
Оголошення, що не відкриваються (404/410 або 301 на пошук), **видаляються з БД і з `data/photos/`** — і при обробці,
і під час перевірки кандидатів у топ (вимога користувача); `gone` лишився лише для сумісності типу.
`reject_reason` починається з `текст:` / `фото N/10` / `немає фото` — на це спираються SQL-запити в README.

## Важливі інваріанти — не ламати

- **Тільки підписка.** `childEnv()` у `claude.ts` видаляє `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDECODE`. Є тест.
- **Ліміт підписки:** перший `ClaudeLimitError` ставить глобальний прапорець, далі нові виклики не запускаються;
  оголошення йде в `pending_analysis` **без** збільшення `attempts` (`countAttempt: false`).
- **Вхід у CLI прострочений** (`401 … token has expired`): `ClaudeAuthError` (підклас `ClaudeLimitError`) — поводиться як ліміт
  (спроби не рахуються, нові виклики не стартують), плюс алерт `claude-auth` і `meta.claude:auth_failed` (час першої
  відмови; очищається, коли якийсь виклик знову пройшов) — за цим ключем плагін SwiftBar показує 🔑 і «Увійти в Claude…».
- **Причини відкладення** — `src/problems.ts` (`describeProblem`): кожна помилка сторінки/Claude/фото дає короткий рядок,
  `Runner.problems` їх групує, підсумок у Telegram показує «• причина: N»; ті самі рядки йдуть у `runs.error` (плагін).
  Нове місце, де оголошення лишається `pending_analysis`, має викликати `this.problem(...)`.
- **Ввічливість до сайту:** жодних прямих `fetch` до сайтів повз `http.ts`; запити строго послідовні.
- Виклик `claude`: `--input-format stream-json --output-format stream-json --verbose` (з виводу береться рядок
  `type: result`), `--tools ''`, `--strict-mcp-config`, `--no-session-persistence`, `--permission-mode dontAsk`,
  власний `--system-prompt`. Фото (768 px, base64) ідуть у тому ж повідомленні перед текстом — один хід, без Read
  (з Read було ~17 ходів і в 1.5× дорожче).
- Текст — `thinking: false` (env `MAX_THINKING_TOKENS=0`): без роздумів утричі дешевше. Замість роздумів модель
  заповнює `must_have` перед вердиктом; `enforceMustHave` ставить `no`, якщо там є `met: false`.
- `--setting-sources ''` обов'язковий: без нього дочірній `claude` підтягує цей CLAUDE.md (+~3k токенів на кожен виклик).
  У лог пишеться usage кожного виклику (`вхід … (кеш …), вихід …, ходів …, ≈$…`) — по ньому видно витрати.
- **Відсіювання робить лише AI, не код** (вимога користувача): жодних regex-фільтрів за заголовком тощо — краще
  пропустити зайве оголошення, ніж помилково відкинути підхоже. З тієї ж причини в промпті: сумнів → `maybe`, не `no`.
- Після змін у `prompts/text.md` або `criteria.md` — перевірити на оголошеннях з БД, що вердикти не поїхали
  (особливо 1-izbový з окремою кухнею → має проходити; garsónka / кухня в єдиній кімнаті → `no`).
- Відповідь моделі валідується zod; поля `extracted` навмисно «loose» (число/рядок/null). `fit_score` і `best_photos`
  опційні — старі записи в БД їх не мають, код має це терпіти.
- `criteria.md` і `prompts/*.md` читаються на кожному виклику — правки діють без перезапуску. Плейсхолдери `{{name}}`
  мають збігатися з ключами у `fillTemplate` в `analyze/index.ts`.
- Схема БД створюється через `CREATE TABLE IF NOT EXISTS` — міграцій немає. Нову колонку в існуючу БД треба
  додавати явно (`ALTER TABLE`), інакше на реальній `data/rent.db` вона не з'явиться.
- Алерти мають cooldown 6 год на тип (ключ `alert:<key>` у `meta`); heartbeat — раз на добу (`meta.heartbeat`).
  У dry-run ці мітки не записуються.
- Підпис Telegram ≤ 1024 символів (тест).
- Підпис = блок фактів (`factLines`: опалення, підлогове опалення, посудомийка, пральна, меблі, кондиціонер, балкон, поверх, паркування —
  завжди, «не вказано» якщо невідомо; тварини/заїзд/хто здає — лише якщо відомі; другий рядок «🗓 На сайті з …» —
  `posted_date`, якщо є) + плюси/мінуси. При перевищенні ліміту
  скорочуються опис і плюси/мінуси, факти — ніколи. `dishwasher`/`floor_heating`/`washing_machine`/`balcony`/`parking` у старих записах відсутні.
- `PhotoResult.seen` (`dishwasher`/`washing_machine`/`air_conditioning`/`balcony`: `true` або `null`, у старих записах немає) —
  те, що видно на фото. Доповнює текст лише там, де `extracted` дає null: у підписі «є (на фото)», у топі іконка й бонус.
  Якщо текст каже так/ні — вірити тексту.
- `extracted.dishwasher` і `extracted.floor_heating` не впливають на вердикт/оцінку, але в топі кожне дає +2
  (`DISHWASHER_BONUS`, `FLOOR_HEATING_BONUS`, `topScore` у `telegram.ts`).
- Топ (`formatTop`) надсилається з `parse_mode: HTML` — увесь текст повідомлення через `escapeHtml`. NEW (жирним) на початку рядка —
  лише при першій появі в топі: `meta.top:seen` — усі, хто колись був у надісланому топі (до 2000 ключів; старий
  `meta.top:last` читається як стартовий список), у dry-run не записується.

## Типові задачі

- **Змінити критерії** — `criteria.md`. Переоцінити: `UPDATE listings SET status='new', attempts=0 WHERE …`.
- **Bazos змінив розмітку** — зберегти свіжий HTML у `fixtures/`, звірити з `docs/source-bazos.md`, полагодити
  `src/sources/bazos.ts`, оновити тести в `tests/bazos.test.ts`.
- **Нове джерело** — `src/sources/<name>.ts`, що реалізує `SourceAdapter`, + реєстрація в `src/sources/index.ts`.
  `fetchListing` має кидати `HttpError` 404/410 для видалених; `isAlive` повертає `null`, якщо перевірити не вдалося.
- **Фільтр пошуку / нове місто** — `bazosQuery` у `src/cities.ts` (канонічна форма без `rubriky`/`Submit`/`crp`/`kitx`,
  інакше ламаються сторінки 2+); вибір — `--city <key>` / env `CITY`. `--digest` — без поштучних повідомлень, лише підсумок з топ-10.
  `--recheck id1,id2` — примусово прогнати заново оголошення з БД (без кешу фото), навіть якщо їх немає в пошуку.
  `--sync` — звірка з сайтом (вручну: `npm run sync`, `schedule.sh sync`, кнопка плагіна): після звичайного прогону
  кожен запис міста з `last_seen` < початку прогону перевіряється через `isAlive`; `false` → `removeListing`,
  `true`/`null` → лишається. Не виконується, якщо пошук упав; у dry-run не видаляє. Результат — рядок у підсумку
  Telegram і `meta.sync:last` (JSON `{at, checked, removed, alive, unknown}`, читає плагін). У щогодинний прогін
  не ввімкнена навмисно (користувач хотів ручний запуск).
  Разовий аналіз міста — сабагент `.claude/agents/rent-city-scan.md`.
- **Нове поле в аналізі** — схема в `schemas.ts` + інструкція в `prompts/*.md` + (за потреби) `buildCaption`.
