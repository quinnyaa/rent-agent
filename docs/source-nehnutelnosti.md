# Джерело: nehnutelnosti.sk

Досліджено 2026-11-16. Fixtures: `fixtures/nehnutelnosti-search-p1.html` (повна сторінка, 30 карток),
`fixtures/nehnutelnosti-search-p4.html` (остання, 6 карток), `fixtures/nehnutelnosti-detail-*.html`.

Fixtures — **не сирий HTML**: сторінка важить 0.4–0.8 МБ, тому з неї лишено тільки дані (JSON-LD і рядки Next.js
flight, див. нижче), розмітку й скрипти прибрано. Імена продавців/агенцій, телефони, e-mail і сайти замінено
заглушками (`Predajca`, `Realitná kancelária`, `0900 000 000`, `predajca@example.com`, `www.example.sk`), блоки з
чужими оголошеннями (схожі, девелоперські проєкти) спорожнено, описи в пошукових fixtures обрізано до 160 символів.
Зберігаючи свіжу сторінку, зробіть те саме перед комітом.

## Загальне

- Сайт на Next.js (App Router). Сторінки віддаються звичайним `GET` зі стандартним User-Agent — повний серверний
  рендер, **Playwright не потрібен**. Cloudflare-челенджу, капчі чи JS-воріт немає (перевірено curl: 200 одразу).
  Якщо з'являться — не обходити, а зупинитись.
- `robots.txt` (`User-Agent: *`) забороняє: `/api/`, `/*?order=` і `/*&order=` (сортування), `/*_rsc=`, `/*?bbox=`,
  `/mapove-vyhladavanie*?`, `/profil/*`, друк тощо. `/vysledky/…` (з `categories`, `priceFrom/To`, `page`) і
  `/detail/…` дозволені. Тому: **не додавати `order=` до пошуку, не ходити в `/api/` і не запитувати `_rsc`**.
- Запити — лише через `src/http.ts` (одна черга, паузи 2–5 с). Домени в `ALLOWED_DOMAINS`:
  `nehnutelnosti.sk` (сторінки на `www.nehnutelnosti.sk`) і `img.unitedclassifieds.sk` (фото).

## Де лежать дані

Розмітку (CSS-класи згенеровані, нестабільні) не парсимо. Дані беруться з двох вбудованих джерел:

1. **Next.js flight** — теги `<script>self.__next_f.push([1,"…"])</script>`. Рядки з усіх тегів треба склеїти; це
   послідовність записів:
   - `<id>:<JSON>\n` — звичайний запис (id — hex, буває порожнім: `:HL[…]`);
   - `<id>:T<довжина в БАЙТАХ, hex>,<текст>` — довгий текст **без** перенесення рядка в кінці; у JSON на нього
     посилаються рядком `"$<id>"` (так приходять довгі описи);
   - `"$undefined"` — відсутнє значення; `"$28:props:…"` — посилання на інший запис.

   Розбір — `flightRows()` у `src/sources/nehnutelnosti.ts`. Об'єкти оголошень шукаються за маркером
   `{"advertisement":{` і вирізаються до парної дужки.
2. **JSON-LD** — `<script type="application/ld+json">` (schema.org). На пошуку це `SearchResultsPage` →
   `mainEntity.itemListElement[].item` з `url`, `name`, `priceSpecification.price`, `validFrom`. Використовується
   лише для **дати** картки (`validFrom` = дата створення; у flight-картках дат немає).

Формат flight — внутрішній для Next.js і може змінитись при оновленні сайту; JSON-LD стабільніший, але в ньому
немає TOP-позначки, адреси, параметрів і повнорозмірних фото.

## Сторінка пошуку

```
https://www.nehnutelnosti.sk/vysledky/poprad/prenajom?categories=11&categories=12&categories=300001&categories=16&categories=17&categories=18&categories=200000&priceTo=750&priceFrom=300
```

Шлях: `/vysledky/<місто>/<транзакція>`; фільтр — `nehnutelnostiPath` у `src/cities.ts` (як в адресному рядку).

### Значення `categories=`

Довідник є у flight-даних сторінки пошуку (`"categories":{"main":[…],"sub":[…]}`):

| id | категорія | | id | категорія |
|---|---|---|---|---|
| 2 | byty (усі) | | 16 | apartmány |
| 300000 | garsónky | | 17 | lofty |
| **11** | 1-izbové byty | | 18 | mezonety |
| **12** | 2-izbové byty | | **200000** | domy (усі будинки) |
| **300001** | 3-izbové byty | | 200001 | rekreačné nehnuteľnosti |
| 14 | 4-izbové byty | | 200002 | pozemky |
| 15 | 5 a viac izbové byty | | 200003 | priestory a objekty |

У фільтрі Попрада: 1/2/3-кімнатні, apartmány, lofty, mezonety і будинки; гарсоньєр (300000) немає.
`priceFrom` / `priceTo` — ціна в €/міс.

### Картки

Об'єкти `{"advertisement":{…}}` у flight (30 на сторінку):

| Поле | Де | Приклад |
|---|---|---|
| ID | `id` | `Ju6N94zLBPM` (11 символів `[A-Za-z0-9_-]`) |
| заголовок | `title` | |
| slug | `slug` | `na-prenajom-prerobeny-…` |
| ціна | `price.price` | `600 €/mes.` (є ще `unitPrice` — `11,11 €/m²/mes.`) |
| площа | `area` | `54` або `"$undefined"` |
| локація | `address.location` | `Podjavorínskej 3387, Poprad, okres Poprad` |
| TOP / Premium | `packages.isTop`, `packages.isPremium` | |
| тип | `subcategory`, `realEstateState` | `2 izbový byt`, `Kompletná rekonštrukcia` |
| продавець | `agency.nameOfAdvertiser` | лише для агенцій |
| опис | `description` | рядок або `"$41"` (посилання на текстовий запис) |
| девелоперський проєкт | `isDevProject` | такі картки пропускаються: інша сутність, сторінка `/detail/developersky-projekt/…` |
| дата | **JSON-LD** `validFrom` (зіставлення за id з `url`) | `2026-11-10T19:10:56.942Z` → `10.11. 2026` |

Окремо у flight є блок `devProjectsInitial` (реклама новобудов по всій Словаччині, `"flags":{…}`, без ключа
`advertisement`) — це не результати пошуку, маркер `{"advertisement":{` їх не зачіпає.

### URL та ID оголошення

- `https://www.nehnutelnosti.sk/detail/<ID>/<slug>`; ID стабільний, slug — із заголовка.
- Неправильний або відсутній slug → **308** на канонічну адресу того самого ID (оголошення живе).

### Пагінація

- Параметр `page=N` (з 2-ї сторінки; перша — без параметра), 30 карток на сторінку.
- Загальна кількість: flight `"totalCount":96,"advertisementsCount":30` (те саме в `<title>`: «(96 inzerátov)» і в
  JSON-LD description: «1-30 inzerát z 96»).
- Сторінка за останньою (`page=5` при 96 оголошеннях) → **HTTP 404** «Stránka nebola nájdená». Тому кількість
  сторінок рахується з `totalCount` і зайвий запит не робиться. Запобіжник — 30 сторінок.
- Порядок типовий (сортування `order=` заборонене robots.txt): спершу TOP, далі решта. TOP-оголошення на сторінці 1
  було 11 з 30; порядок між запитами трохи змінюється (ротація TOP), тому дедуп за ID обов'язковий.
- Знімок 2026-11-16: 96 оголошень, 96 унікальних ID, ціни 350–750 €, усі з числовою ціною.

### Ціна

- `price.price` — `600 €/mes.`; парсимо цифри до `€`. Буває текст без числа (`Cena dohodou`, `Info v RK`) →
  `price = null`, зберігається сирий рядок.
- `priceText` стабільний між запитами (у ньому немає нічого, що змінюється при кожному завантаженні) — від нього
  залежить `price_changed`. На сторінці оголошення той самий рядок (`parameters.price.price`).

## Сторінка оголошення

Об'єкт `{"advertisement":{"id":…,"parameters":{…}}}` у flight:

| Поле | Де | Примітка |
|---|---|---|
| заголовок | `title` | |
| активність | `isActive` | `false` → оголошення зняте (див. нижче) |
| опис | `description` | рядок або `"$2f"` → текстовий запис `2f:T8b2,…` |
| дати | `createdAt`, `publishedAt`, `updatedAt` | беремо `createdAt` (як `validFrom` у пошуку); `updatedAt` змінюється часто |
| фото | `media.photos[]` | `origUrl`, `largeUrl`, `mediumUrl`, `smallUrl`, `info.width/height` |
| інше медіа | `media.videos`, `media.floorPlans`, `media.inspections3d` | не використовуються |
| TOP | `flags.isTop`, `flags.isPremium` | |
| локація | `location.name` (+ `street`, `streetNumber`, `city`, `district`, `point`) | `point` — приблизні координати з `radius` |
| параметри | `parameters` | див. нижче |
| продавець | `advertiser.type` (`AGENT` / `PRIVATE_PERSON`), `advertiser.agency.name` | ім'я і телефон не беремо |

### Параметри (`parameters`)

`title` («2 izbový byt na prenájom»), `area`, `floor`, `numberOfFloors`, `hasElevator`, `construction`,
`realEstateState`, `yearOfConstruction`, `energyRatingCertificate`, `price` (`price`, `priceNum`, `unitPrice`,
`powerCosts: {value, areIncluded}`), `attributes[]` (`label`/`value`: Vykurovanie, Telekomunikácie, …).
Більшість полів необов'язкові — у приватних оголошеннях часто є лише `title`, `price`, `realEstateState`.

У `Listing.description` вони йдуть блоком перед вільним текстом:

```
Parametre:
- Typ: 2 izbový byt na prenájom
- Lokalita: Podjavorínskej 3387, Poprad, okres Poprad
- Cena: 600 €/mes.
- Plocha: 54 m²
- Poschodie: 3 z 8
- Stav: Kompletná rekonštrukcia
- Vykurovanie: Ústredné
- Inzerent: realitná kancelária (…)

<вільний текст опису>
```

Пастки:
- `hasElevator: false` і `powerCosts.areIncluded: false` — **типові значення**, а не твердження (оголошення з
  ліфтом і з енергіями в ціні мало обидва `false`). Тому «Výťah» пишеться лише при `true`, «Energie» — лише при
  `areIncluded: true` або непорожньому `value` («110 €/mes., nie sú zahrnuté v cene»).
- Невідомі скалярні поля `parameters` додаються як є (`ключ: значення`), щоб нові параметри не губились.

### Опис і контакти

- Телефони й e-mail у тексті опису сайт сам ховає за заглушкою
  `<span class="inline-contact" …><span class="inline-contact-value">...</span></span>` → замінюється на
  `[kontakt skrytý]`; решта HTML-тегів вирізається. Справжній номер віддає лише API (заборонений robots.txt) —
  **не запитуємо**. (У JSON-LD сторінки пошуку описи йдуть без маскування — ми їх не використовуємо.)

### Фото

- Хост: **`img.unitedclassifieds.sk`** (єдиний). URL: `/foto/<base64 операції>/<id фото>?st=<підпис>&ts=<час>&e=0`.
- Сегмент base64 — операція обробки: `origUrl` = `filters:format(webp)/jul` (оригінал, напр. 4388×2971, ~0.4 МБ),
  `largeUrl` = `fit-in/1560x4000/…`, `mediumUrl` = `fit-in/780x2000/…`, `smallUrl` = `fit-in/390x1000/…`.
  Підпис `st` прив'язаний до операції — свій розмір зібрати не можна, беремо готові URL.
- Беремо `origUrl` (якщо немає — `largeUrl`). Формат WebP — sharp читає. Усі фото оголошення є в `media.photos`
  (11–13 у досліджених), окремих запитів на галерею не треба.
- `st`/`ts` між завантаженнями сторінки **не змінюються** (перевірено з інтервалом 15 хв), тож кеш оцінки фото
  «список URL не змінився» працює.

### Видалене / неактивне оголошення

| Ситуація | Відповідь | Як обробляється |
|---|---|---|
| ID не існує / оголошення видалене | **307** → `https://www.nehnutelnosti.sk/vysledky` (і на GET, і на HEAD) | кінцева адреса не `/detail/<той самий ID>/` → `HttpError(410)`; `isAlive` → `false` |
| інший slug | 308 → `/detail/<ID>/<канонічний slug>` | живе |
| зняте з публікації, але сторінка ще віддається | 200, `isActive: false` (поруч `isWithinGracePeriod`) | `HttpError(410)`; `isAlive` → `false` |
| 404 / 410 | — | `isAlive` → `false` |
| 5xx, мережа, сторінка без даних оголошення | — | `isAlive` → `null` (перевірити не вдалося) |

`isActive: false` наживо не спостерігався (усі досліджені оголошення активні) — поведінка виведена з назв полів
`isActive` / `isWithinGracePeriod`; якщо трапиться таке оголошення, варто зберегти його як fixture.
`isAlive` робить `GET`, а не `HEAD`: неактивність видно лише в тілі сторінки.

## Дублікати з bazos

Агенції часто публікують ту саму квартиру і тут, і на bazos. У знімку 2026-11-16 приблизно половина з 96 оголошень
мала ймовірного двійника на bazos (та сама ціна й майже той самий заголовок).

Обробка — `src/dedup.ts`: дублікатом вважається лише безсумнівний випадок — та сама ціна і той самий текст
оголошення (без пробілів, регістру, діакритики, контактів і блоку «Parametre:»; текст не коротший за 200 символів).
Тексти справді збігаються: у перевіреній парі різниця була лише в порожніх рядках і в телефоні, який nehnutelnosti
ховає за `[kontakt skrytý]`. Схожий заголовок сам по собі дублікатом не є (одна агенція має кілька різних квартир
з однаковим заголовком). Скільки з «ймовірних» двійників пройде сувору перевірку, видно в лозі прогону
(«→ дублікат bazos:…») і в підсумку («♻️ дублікати з іншого сайту»).
