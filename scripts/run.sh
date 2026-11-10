#!/bin/bash
# Запуск одного прогону (launchd або вручну з аргументами, напр. --sync): правильний PATH + лог по днях у data/logs/
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p data/logs
LOG="data/logs/$(date +%Y-%m-%d).log"
if [ $# -eq 0 ]; then HOW="launchd"; else HOW="вручну: $*"; fi
echo "===== $(date '+%Y-%m-%d %H:%M:%S') запуск $HOW =====" >> "$LOG"
node --disable-warning=ExperimentalWarning --import tsx src/run.ts "$@" >> "$LOG" 2>&1
code=$?
echo "===== завершено, код $code =====" >> "$LOG"
# Логи старші за 30 днів — видаляємо
find data/logs -name '*.log' -mtime +30 -delete 2>/dev/null
exit $code
