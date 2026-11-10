#!/bin/bash
# Автозапуск через launchd (macOS).
#   scripts/schedule.sh install [хвилин]   — встановити/оновити і ввімкнути (за замовчуванням кожні 60 хв)
#   scripts/schedule.sh uninstall          — видалити повністю (прибирає plist)
#   scripts/schedule.sh disable            — вимкнути, plist лишається; стан переживає перезавантаження
#   scripts/schedule.sh enable             — ввімкнути назад
#   scripts/schedule.sh status             — стан: увімкнено / вимкнено / не встановлено
#   scripts/schedule.sh run-now            — запустити зараз поза розкладом
#   scripts/schedule.sh sync               — прогін зі звіркою: нові з пошуку + видалення зниклих із БД (у фоні)
set -eu
LABEL="com.rentagent.poprad"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

is_disabled() {
  launchctl print-disabled "$DOMAIN" 2>/dev/null | grep -Eq "\"$LABEL\"[[:space:]]*=>[[:space:]]*(disabled|true)"
}

is_loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

case "${1:-}" in
  install)
    MIN="${2:-60}"
    mkdir -p "$DIR/data/logs" "$HOME/Library/LaunchAgents"
    chmod +x "$DIR/scripts/run.sh"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$DIR/scripts/run.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartInterval</key><integer>$((MIN * 60))</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$DIR/data/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/logs/launchd.err.log</string>
</dict>
</plist>
PLIST
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl enable "$DOMAIN/$LABEL"
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Встановлено й увімкнено: кожні $MIN хв + одразу після входу в систему. Логи: $DIR/data/logs/"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Автозапуск видалено"
    ;;
  disable)
    if [ ! -f "$PLIST" ]; then
      echo "Не встановлено: нічого вимикати"; exit 1
    fi
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl disable "$DOMAIN/$LABEL"
    echo "Автозапуск вимкнено (діє й після перезавантаження). Увімкнути: bash scripts/schedule.sh enable"
    ;;
  enable)
    if [ ! -f "$PLIST" ]; then
      exec bash "$0" install
    fi
    launchctl enable "$DOMAIN/$LABEL"
    if ! is_loaded; then
      launchctl bootstrap "$DOMAIN" "$PLIST"
    fi
    echo "Автозапуск увімкнено"
    ;;
  status)
    if [ ! -f "$PLIST" ] && ! is_loaded; then
      echo "Стан: не встановлено"
    elif is_disabled; then
      echo "Стан: вимкнено"
    elif is_loaded; then
      echo "Стан: увімкнено"
      INFO="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null)"
      SEC="$(printf '%s\n' "$INFO" | sed -n 's/.*run interval = \([0-9]*\) seconds.*/\1/p' | head -1)"
      [ -n "$SEC" ] && echo "Інтервал: $((SEC / 60)) хв"
      printf '%s\n' "$INFO" | sed -n 's/^[[:space:]]*state = \(.*\)/Процес: \1/p' | head -1
      CODE="$(printf '%s\n' "$INFO" | sed -n 's/^[[:space:]]*last exit code = \(.*\)/\1/p' | head -1)"
      echo "Код виходу останнього запуску: ${CODE:-—}"
      RUNS="$(printf '%s\n' "$INFO" | sed -n 's/^[[:space:]]*runs = \([0-9]*\)/\1/p' | head -1)"
      echo "Запусків: ${RUNS:-0}"
    else
      echo "Стан: не завантажено (є plist, але не bootstrapped). Виконайте: bash scripts/schedule.sh enable"
    fi
    ;;
  run-now)
    launchctl kickstart "$DOMAIN/$LABEL"
    echo "Запущено. Лог: tail -f $DIR/data/logs/$(date +%Y-%m-%d).log"
    ;;
  sync)
    # Не через launchd: працює і при вимкненому автозапуску. Від одночасного прогону захищає data/run.lock.
    chmod +x "$DIR/scripts/run.sh"
    nohup /bin/bash "$DIR/scripts/run.sh" --sync >/dev/null 2>&1 &
    disown 2>/dev/null || true
    echo "Звірку запущено у фоні. Лог: tail -f $DIR/data/logs/$(date +%Y-%m-%d).log"
    ;;
  *)
    sed -n '2,9p' "$0"; exit 1 ;;
esac
