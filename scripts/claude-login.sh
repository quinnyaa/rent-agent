#!/bin/bash
# Вхід у Claude CLI (підписка) — викликається з плагіна SwiftBar, коли прогони падають через авторизацію.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDECODE
claude auth login
echo
echo "Готово. Наступний прогін перевірить вхід; це вікно можна закрити."
