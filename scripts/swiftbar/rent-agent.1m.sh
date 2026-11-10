#!/bin/bash
# <xbar.title>rent-agent</xbar.title>
# <xbar.desc>Стан rent-agent (launchd) і кнопки керування</xbar.desc>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
#
# Плагін SwiftBar: значок у рядку меню + меню керування. Оновлюється раз на хвилину (1m у назві).
# Встановлюється як symlink у папку плагінів SwiftBar, тому шлях до репозиторію береться з readlink.
# Без мережі; SwiftBar дає мінімальне оточення, тому всі шляхи абсолютні.
set -u

SRC="${BASH_SOURCE[0]}"
while [ -L "$SRC" ]; do
  T="$(/usr/bin/readlink "$SRC")"
  case "$T" in /*) SRC="$T" ;; *) SRC="$(/usr/bin/dirname "$SRC")/$T" ;; esac
done
REPO="$(cd "$(/usr/bin/dirname "$SRC")/../.." && pwd -P)"

LABEL="com.rentagent.poprad"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(/usr/bin/id -u)"
DB="$REPO/data/rent.db"
LOCK="$REPO/data/run.lock"
SCHEDULE="$REPO/scripts/schedule.sh"
TODAY_LOG="$REPO/data/logs/$(/bin/date +%Y-%m-%d).log"
ERR_LOG="$REPO/data/logs/launchd.err.log"

# Пункти без дії SwiftBar малює сірими, як неактивні кнопки. Явний колір (світла,темна тема) це перекриває.
TXT="color=#1D1D1F,#F5F5F7"
DIM="color=#6E6E73,#AEAEB2"
RED="color=#D70015,#FF6961"

# --- Прогін іде? (lock існує і PID живий) ---
RUNNING=0
if [ -f "$LOCK" ]; then
  PID="$(/usr/bin/tr -dc '0-9' < "$LOCK")"
  [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && RUNNING=1
fi

# --- Стан launchd ---
INFO="$(/bin/launchctl print "$DOMAIN/$LABEL" 2>/dev/null)"
if /bin/launchctl print-disabled "$DOMAIN" 2>/dev/null \
   | /usr/bin/grep -Eq "\"$LABEL\"[[:space:]]*=>[[:space:]]*(disabled|true)"; then
  STATE="вимкнено"
elif [ -n "$INFO" ]; then
  STATE="увімкнено"
else
  STATE="не встановлено"
fi
INTERVAL_SEC=""
EXIT_CODE=""
if [ -n "$INFO" ]; then
  INTERVAL_SEC="$(printf '%s\n' "$INFO" | /usr/bin/sed -n 's/.*run interval = \([0-9]*\) seconds.*/\1/p' | /usr/bin/head -1)"
  EXIT_CODE="$(printf '%s\n' "$INFO" | /usr/bin/sed -n 's/^[[:space:]]*last exit code = \(-*[0-9][0-9]*\).*/\1/p' | /usr/bin/head -1)"
fi
if [ -z "$INTERVAL_SEC" ] && [ -f "$PLIST" ]; then
  INTERVAL_SEC="$(/usr/bin/plutil -extract StartInterval raw "$PLIST" 2>/dev/null)"
fi

# --- Дані з БД (одним запитом) ---
# Лише запуски/оголошення Попраду (основний автозапуск); разові прогони інших міст (--city) не враховуються.
# Поля: id, початок (HH:MM), сьогодні?, дата, хв тому, тривалість с, завершено?, наступний (HH:MM), наступний у минулому?,
#       запусків сьогодні, нових сьогодні, підхожих сьогодні, всього підхожих,
#       Claude не авторизований з (дд.мм ГГ:ХХ; порожньо — усе гаразд),
#       остання звірка --sync (дд.мм ГГ:ХХ; порожньо — ще не було), видалено під час неї, помилка (обрізана)
ROW=""
if [ -s "$DB" ]; then
  # Без -readonly: після закриття БД агентом файлів -wal/-shm немає, а readonly-з'єднання не може їх створити
  ROW="$(/usr/bin/sqlite3 -cmd '.timeout 300' -separator $'\x1f' "$DB" "
    WITH last AS (SELECT * FROM runs WHERE city = 'Poprad' ORDER BY id DESC LIMIT 1),
         today AS (SELECT * FROM runs
                   WHERE city = 'Poprad' AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'localtime', 'start of day', 'utc'))
    SELECT l.id,
           strftime('%H:%M', l.started_at, 'localtime'),
           date(l.started_at, 'localtime') = date('now', 'localtime'),
           strftime('%d.%m', l.started_at, 'localtime'),
           CAST((julianday('now') - julianday(l.started_at)) * 1440 AS INTEGER),
           CAST(round((julianday(l.finished_at) - julianday(l.started_at)) * 86400) AS INTEGER),
           l.finished_at IS NOT NULL,
           strftime('%H:%M', l.started_at, '+${INTERVAL_SEC:-0} seconds', 'localtime'),
           datetime(l.started_at, '+${INTERVAL_SEC:-0} seconds') < datetime('now'),
           (SELECT count(*) FROM today),
           (SELECT coalesce(sum(new_count), 0) FROM today),
           (SELECT coalesce(sum(matched), 0) FROM today),
           (SELECT count(*) FROM listings WHERE status IN ('matched', 'notified') AND city = 'Poprad'),
           coalesce((SELECT strftime('%d.%m %H:%M', value, 'localtime') FROM meta
                     WHERE key = 'claude:auth_failed' AND value != ''), ''),
           coalesce((SELECT strftime('%d.%m %H:%M', json_extract(value, '$.at'), 'localtime') FROM meta WHERE key = 'sync:last'), ''),
           coalesce((SELECT json_extract(value, '$.removed') FROM meta WHERE key = 'sync:last'), ''),
           CASE WHEN length(l.error) > 80 THEN substr(replace(replace(l.error, char(10), ' '), '|', '¦'), 1, 79) || '…'
                ELSE replace(replace(l.error, char(10), ' '), '|', '¦') END
    FROM last l;" 2>/dev/null)"
fi
IFS=$'\x1f' read -r R_ID R_START R_IS_TODAY R_DATE R_AGO R_DUR R_DONE R_NEXT R_NEXT_PAST \
  T_RUNS T_NEW T_MATCHED TOTAL_MATCHED AUTH_SINCE SYNC_AT SYNC_REMOVED R_ERR <<< "$ROW"

# --- Значок: ⏳ іде → ⏸ вимкнено → 🔑 Claude не авторизований → ⚠️ помилка → 🏠 гаразд ---
HAS_ERR=0
[ -n "${R_ERR:-}" ] && HAS_ERR=1
[ -n "$EXIT_CODE" ] && [ "$EXIT_CODE" != "0" ] && HAS_ERR=1
# Прогін без finished_at і без живого процесу — впав жорстко
[ -n "${R_ID:-}" ] && [ "${R_DONE:-1}" = "0" ] && [ "$RUNNING" = "0" ] && HAS_ERR=1

if [ "$RUNNING" = "1" ]; then ICON="⏳"
elif [ "$STATE" != "увімкнено" ]; then ICON="⏸"
elif [ -n "${AUTH_SINCE:-}" ]; then ICON="🔑"
elif [ "$HAS_ERR" = "1" ]; then ICON="⚠️"
else ICON="🏠"
fi

fmt_dur() {
  local s="$1"
  if [ -z "$s" ]; then echo "—"
  elif [ "$s" -lt 60 ]; then echo "$s с"
  else echo "$((s / 60)) хв $((s % 60)) с"
  fi
}
fmt_ago() {
  local m="$1"
  if [ "$m" -lt 1 ]; then echo "щойно"
  elif [ "$m" -lt 60 ]; then echo "$m хв тому"
  elif [ "$m" -lt 1440 ]; then echo "$((m / 60)) год $((m % 60)) хв тому"
  else echo "$((m / 1440)) дн тому"
  fi
}

echo "$ICON"
echo "---"

# --- Стан автозапуску: кольорова іконка; клік оновлює меню ---
case "$STATE" in
  увімкнено)
    TITLE="Автозапуск увімкнено"
    [ -n "$INTERVAL_SEC" ] && TITLE="$TITLE · кожні $((INTERVAL_SEC / 60)) хв"
    echo "$TITLE | sfimage=checkmark.circle.fill sfcolor=#34C759 $TXT refresh=true" ;;
  вимкнено)
    echo "Автозапуск вимкнено | sfimage=pause.circle.fill sfcolor=#FF9F0A $TXT refresh=true" ;;
  *)
    echo "Автозапуск не встановлено | sfimage=xmark.circle.fill sfcolor=#8E8E93 $TXT refresh=true" ;;
esac

# --- Останній запуск; подробиці в підменю ---
if [ -z "${R_ID:-}" ]; then
  echo "Ще не запускався | sfimage=moon.zzz $DIM refresh=true"
else
  WHEN="$R_START"
  [ "$R_IS_TODAY" = "1" ] || WHEN="$R_DATE $R_START"
  if [ "$RUNNING" = "1" ] && [ "$R_DONE" = "0" ]; then
    echo "Іде прогін · з $WHEN ($(fmt_ago "$R_AGO")) | sfimage=hourglass sfcolor=#0A84FF $TXT"
  elif [ "$R_DONE" = "0" ]; then
    echo "Останній запуск · $WHEN · перервано | sfimage=xmark.octagon.fill sfcolor=#FF453A $TXT"
  elif [ -n "$R_ERR" ]; then
    echo "Останній запуск · $WHEN · з помилками | sfimage=exclamationmark.triangle.fill sfcolor=#FF9F0A $TXT"
  else
    echo "Останній запуск · $WHEN ($(fmt_ago "$R_AGO")) | sfimage=checkmark.seal.fill sfcolor=#34C759 $TXT"
  fi
  [ "$R_DONE" = "1" ] && echo "--Тривалість: $(fmt_dur "$R_DUR") | sfimage=timer $TXT"
  if [ "$STATE" = "увімкнено" ]; then
    if [ "$R_NEXT_PAST" = "1" ]; then NEXT="незабаром"; else NEXT="~$R_NEXT"; fi
    echo "--Наступний: $NEXT | sfimage=calendar.badge.clock $TXT"
  fi
  echo "-----"
  echo "--Сьогодні: запусків $T_RUNS · нових $T_NEW · підхожих $T_MATCHED | sfimage=sun.max $TXT"
  echo "--Всього підхожих: $TOTAL_MATCHED | sfimage=star.fill sfcolor=#FFCC00 $TXT"
  [ -n "${SYNC_AT:-}" ] && echo "--Остання звірка: $SYNC_AT · видалено ${SYNC_REMOVED:-0} | sfimage=arrow.triangle.2.circlepath $TXT"
fi

# --- Claude не авторизований: прогони нічого не аналізують, доки не увійти; клік відкриває вхід у терміналі ---
if [ -n "${AUTH_SINCE:-}" ]; then
  echo "Claude не авторизований (з $AUTH_SINCE) — оголошення не аналізуються | sfimage=key.fill sfcolor=#FF453A $RED"
  echo "Увійти в Claude… | sfimage=person.badge.key bash=\"$REPO/scripts/claude-login.sh\" terminal=true refresh=true"
fi

# --- Помилки: червоним, клік відкриває лог ---
if [ -n "${R_ERR:-}" ]; then
  ACT=""
  [ -f "$TODAY_LOG" ] && ACT="bash=/usr/bin/open param1=\"$TODAY_LOG\" terminal=false"
  echo "Помилка: $R_ERR | sfimage=exclamationmark.triangle.fill sfcolor=#FF453A $RED emojize=false $ACT"
fi
if [ -n "$EXIT_CODE" ] && [ "$EXIT_CODE" != "0" ]; then
  echo "launchd: код виходу $EXIT_CODE | sfimage=exclamationmark.triangle.fill sfcolor=#FF453A $RED bash=/usr/bin/open param1=\"$ERR_LOG\" terminal=false"
fi

echo "---"
if [ "$RUNNING" = "1" ]; then
  echo "Запустити зараз (уже йде) | sfimage=play.fill"
elif [ "$STATE" = "увімкнено" ]; then
  echo "Запустити зараз | sfimage=play.fill bash=/bin/bash param1=\"$SCHEDULE\" param2=run-now terminal=false refresh=true"
else
  echo "Запустити зараз (спершу увімкніть автозапуск) | sfimage=play.fill"
fi
# Звірка: звичайний прогін + видалення з БД оголошень, яких уже немає на сайті. Працює і без автозапуску.
if [ "$RUNNING" = "1" ]; then
  echo "Звірити з сайтом (іде прогін) | sfimage=arrow.triangle.2.circlepath"
else
  echo "Звірити з сайтом | sfimage=arrow.triangle.2.circlepath bash=/bin/bash param1=\"$SCHEDULE\" param2=sync terminal=false refresh=true"
fi
if [ "$STATE" = "увімкнено" ]; then
  echo "Вимкнути автозапуск | sfimage=pause.fill bash=/bin/bash param1=\"$SCHEDULE\" param2=disable terminal=false refresh=true"
else
  echo "Увімкнути автозапуск | sfimage=power bash=/bin/bash param1=\"$SCHEDULE\" param2=enable terminal=false refresh=true"
fi

echo "---"
if [ -f "$TODAY_LOG" ]; then
  echo "Лог за сьогодні | sfimage=doc.text bash=/usr/bin/open param1=\"$TODAY_LOG\" terminal=false"
else
  echo "Лог за сьогодні (ще немає) | sfimage=doc.text"
fi
echo "Shortlist | sfimage=star bash=/usr/bin/open param1=\"$REPO/shortlist.md\" terminal=false"
echo "Папка проєкту | sfimage=folder bash=/usr/bin/open param1=\"$REPO\" terminal=false"
