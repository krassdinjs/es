#!/bin/bash

echo "=========================================="
echo "  ИСПРАВЛЕНИЕ ТАЙМАУТОВ NGINX"
echo "=========================================="
echo ""

DOMAIN="effllows-m50.com"
NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}"

if [ ! -f "$NGINX_CONF" ]; then
    echo "❌ Конфиг не найден: $NGINX_CONF"
    exit 1
fi

echo "📝 Обновление конфига: $NGINX_CONF"
echo ""

# Создаем резервную копию
cp "$NGINX_CONF" "${NGINX_CONF}.backup.$(date +%Y%m%d_%H%M%S)"
echo "✅ Резервная копия создана"

# Проверяем, есть ли уже таймауты
if grep -q "proxy_read_timeout" "$NGINX_CONF"; then
    echo "⚠️  Таймауты уже есть, обновляем..."
    # Обновляем существующие таймауты
    sed -i 's/proxy_read_timeout.*/proxy_read_timeout 300s;/' "$NGINX_CONF"
    sed -i 's/proxy_connect_timeout.*/proxy_connect_timeout 75s;/' "$NGINX_CONF"
    if ! grep -q "proxy_send_timeout" "$NGINX_CONF"; then
        # Добавляем proxy_send_timeout после proxy_connect_timeout
        sed -i '/proxy_connect_timeout/a\        proxy_send_timeout 300s;' "$NGINX_CONF"
    else
        sed -i 's/proxy_send_timeout.*/proxy_send_timeout 300s;/' "$NGINX_CONF"
    fi
else
    echo "➕ Добавляем таймауты..."
    # Находим location / блок и добавляем таймауты после proxy_request_buffering
    if grep -q "proxy_request_buffering off" "$NGINX_CONF"; then
        sed -i '/proxy_request_buffering off/a\        proxy_read_timeout 300s;\n        proxy_connect_timeout 75s;\n        proxy_send_timeout 300s;' "$NGINX_CONF"
    else
        # Если нет proxy_request_buffering, добавляем после proxy_buffering
        sed -i '/proxy_buffering off/a\        proxy_read_timeout 300s;\n        proxy_connect_timeout 75s;\n        proxy_send_timeout 300s;' "$NGINX_CONF"
    fi
fi

echo ""
echo "📋 Проверка изменений:"
grep -A 10 "location /" "$NGINX_CONF" | grep -E "proxy_read_timeout|proxy_connect_timeout|proxy_send_timeout" || echo "Таймауты не найдены в location /"

echo ""
echo "🔍 Проверка синтаксиса Nginx:"
nginx -t

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Синтаксис корректен"
    echo "🔄 Перезагрузка Nginx..."
    systemctl reload nginx
    echo "✅ Nginx перезагружен"
    echo ""
    echo "Проверьте таймауты:"
    grep -E "proxy_read_timeout|proxy_connect_timeout|proxy_send_timeout" "$NGINX_CONF"
else
    echo ""
    echo "❌ Ошибка в конфигурации!"
    echo "Восстановление из резервной копии..."
    cp "${NGINX_CONF}.backup."* "$NGINX_CONF" 2>/dev/null
    echo "Проверьте конфиг вручную"
    exit 1
fi

echo ""
echo "=========================================="
