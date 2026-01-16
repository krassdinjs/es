#!/bin/bash
# Одна команда для установки новой системы отслеживания

cd ~/reverse-proxy && \
npm install better-sqlite3 useragent --save && \
cp telegram-logger.js telegram-logger.js.backup && \
mv telegram-logger-new.js telegram-logger.js && \
pm2 restart all && \
echo "✅ Новая система отслеживания установлена и запущена!"
