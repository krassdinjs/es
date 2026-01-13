#!/bin/bash

echo "=========================================="
echo "  ПРОВЕРКА СТАТУСА СЕРВИСОВ"
echo "=========================================="
echo ""

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 1. Проверка health напрямую через порт 3000
echo "1️⃣  Health endpoint (прямой доступ к Node.js):"
echo "----------------------------------------"
HEALTH_DIRECT=$(curl -s -w "\nHTTP:%{http_code}\nTIME:%{time_total}s" --max-time 5 http://127.0.0.1:3000/health 2>&1)
if echo "$HEALTH_DIRECT" | grep -q "HTTP:200"; then
    echo -e "${GREEN}✅ Работает${NC}"
    echo "$HEALTH_DIRECT" | grep -v "HTTP:\|TIME:"
else
    echo -e "${RED}❌ Не работает${NC}"
    echo "$HEALTH_DIRECT"
fi
echo ""

# 2. Проверка health через Nginx (HTTPS)
echo "2️⃣  Health endpoint через Nginx (HTTPS):"
echo "----------------------------------------"
HEALTH_NGINX=$(curl -s -w "\nHTTP:%{http_code}\nTIME:%{time_total}s" --max-time 10 -k https://effllows-m50.com/health 2>&1)
if echo "$HEALTH_NGINX" | grep -q "HTTP:200"; then
    echo -e "${GREEN}✅ Работает${NC}"
    echo "$HEALTH_NGINX" | grep -v "HTTP:\|TIME:"
else
    echo -e "${RED}❌ Не работает${NC}"
    echo "$HEALTH_NGINX"
fi
echo ""

# 3. Проверка pay-toll через Nginx (HTTPS) с таймаутом
echo "3️⃣  Проверка /pay-toll через Nginx (HTTPS, таймаут 15 сек):"
echo "----------------------------------------"
PAYTOLL=$(curl -s -w "\nHTTP:%{http_code}\nTIME:%{time_total}s" --max-time 15 -k -I https://effllows-m50.com/pay-toll 2>&1)
HTTP_CODE=$(echo "$PAYTOLL" | grep "HTTP:" | cut -d: -f2 | tr -d ' ')
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "301" ] || [ "$HTTP_CODE" = "302" ]; then
    echo -e "${GREEN}✅ Работает (HTTP $HTTP_CODE)${NC}"
    echo "$PAYTOLL" | head -10
else
    echo -e "${RED}❌ Не работает (HTTP $HTTP_CODE)${NC}"
    echo "$PAYTOLL"
fi
echo ""

# 4. Поиск логов Nginx
echo "4️⃣  Поиск логов Nginx:"
echo "----------------------------------------"
NGINX_LOGS=(
    "/var/log/nginx/effllows-m50-error.log"
    "/var/log/nginx/effllows-m50.com-error.log"
    "/var/log/nginx/error.log"
    "/var/log/nginx/access.log"
)

for log in "${NGINX_LOGS[@]}"; do
    if [ -f "$log" ]; then
        echo -e "${GREEN}✅ Найден: $log${NC}"
        echo "Последние 5 строк:"
        tail -5 "$log"
        echo ""
    fi
done

# 5. Проверка конфигурации Nginx
echo "5️⃣  Проверка конфигурации Nginx:"
echo "----------------------------------------"
NGINX_CONF="/etc/nginx/sites-enabled/effllows-m50.com"
if [ -f "$NGINX_CONF" ] || [ -L "$NGINX_CONF" ]; then
    echo -e "${GREEN}✅ Конфиг найден: $NGINX_CONF${NC}"
    echo "Проверка таймаутов:"
    grep -E "proxy_read_timeout|proxy_connect_timeout|proxy_send_timeout" "$NGINX_CONF" || echo "Таймауты не найдены (используются значения по умолчанию)"
else
    echo -e "${YELLOW}⚠️  Конфиг не найден: $NGINX_CONF${NC}"
    echo "Доступные конфиги:"
    ls -la /etc/nginx/sites-enabled/ | grep effllows
fi
echo ""

# 6. Проверка процессов
echo "6️⃣  Статус процессов:"
echo "----------------------------------------"
pm2 status
echo ""

# 7. Проверка порта 3000
echo "7️⃣  Порт 3000:"
echo "----------------------------------------"
if ss -tuln 2>/dev/null | grep -q ":3000"; then
    echo -e "${GREEN}✅ Слушается${NC}"
    ss -tuln | grep ":3000"
else
    echo -e "${RED}❌ Не слушается${NC}"
fi
echo ""

echo "=========================================="
