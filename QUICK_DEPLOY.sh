#!/bin/bash

# Быстрое развертывание на сервере
# Выполните: bash QUICK_DEPLOY.sh

echo "🚀 Начало развертывания..."

# Шаг 1: Обновление кода
echo "📥 Обновление кода с GitHub..."
cd ~/reverse-proxy || cd /path/to/reverse-proxy
git pull origin main

# Шаг 2: Установка зависимостей
echo "📦 Установка зависимостей..."
npm install

# Шаг 3: Проверка .env
echo "⚙️  Проверка .env файла..."
if [ ! -f .env ]; then
    echo "⚠️  .env файл не найден! Создайте его вручную."
    echo "См. SERVER_DEPLOYMENT.md для инструкций"
else
    echo "✅ .env файл найден"
fi

# Шаг 4: Проверка domains.json
if [ ! -f domains.json ]; then
    echo "📝 Создание domains.json..."
    echo '{"domains":[],"currentDomain":"","lastSync":null}' > domains.json
fi

# Шаг 5: Перезапуск PM2
echo "🔄 Перезапуск сервера..."
if command -v pm2 &> /dev/null; then
    pm2 restart reverse-proxy || pm2 restart all
    echo "✅ Сервер перезапущен через PM2"
    pm2 logs reverse-proxy --lines 20
else
    echo "⚠️  PM2 не найден. Перезапустите сервер вручную."
fi

# Шаг 6: Настройка webhook
echo "🔗 Настройка Telegram webhook..."
read -p "Введите ваш домен (например: eflows-m50.com): " DOMAIN
if [ ! -z "$DOMAIN" ]; then
    curl -X POST "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/setWebhook?url=https://${DOMAIN}/api/telegram/webhook"
    echo ""
    echo "✅ Webhook установлен"
else
    echo "⚠️  Домен не указан. Установите webhook вручную."
fi

echo ""
echo "✅ Развертывание завершено!"
echo "📋 Проверьте логи: pm2 logs reverse-proxy"
echo "🤖 Протестируйте бота в Telegram: /start"
