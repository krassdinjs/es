#!/bin/bash

echo "=========================================="
echo "  БЫСТРОЕ ИСПРАВЛЕНИЕ 504 ОШИБКИ"
echo "=========================================="
echo ""

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cd ~/reverse-proxy || cd /root/reverse-proxy || exit 1

# 1. Остановка всех процессов PM2
echo "1️⃣  Остановка PM2 процессов..."
pm2 stop all 2>/dev/null
pm2 delete all 2>/dev/null
sleep 2

# 2. Проверка .env
echo ""
echo "2️⃣  Проверка .env файла..."
if [ -f ".env" ]; then
    echo -e "${GREEN}✅ .env найден${NC}"
    if grep -q "CUSTOM_DOMAIN" .env; then
        echo "CUSTOM_DOMAIN установлен"
    else
        echo -e "${YELLOW}⚠️  CUSTOM_DOMAIN не найден в .env${NC}"
    fi
else
    echo -e "${RED}❌ .env не найден${NC}"
fi

# 3. Запуск через PM2
echo ""
echo "3️⃣  Запуск приложения..."
if [ -f "pm2.config.js" ]; then
    pm2 start pm2.config.js --update-env
else
    pm2 start server.js --name reverse-proxy --update-env
fi

pm2 save

# 4. Ожидание запуска
echo ""
echo "4️⃣  Ожидание запуска (10 секунд)..."
sleep 10

# 5. Проверка статуса
echo ""
echo "5️⃣  Проверка статуса..."
pm2 status

# 6. Проверка порта
echo ""
echo "6️⃣  Проверка порта 3000..."
if command -v netstat &> /dev/null; then
    if netstat -tuln 2>/dev/null | grep -q ":3000"; then
        echo -e "${GREEN}✅ Порт 3000 слушается${NC}"
        netstat -tuln 2>/dev/null | grep ":3000"
    else
        echo -e "${RED}❌ Порт 3000 НЕ слушается${NC}"
    fi
elif command -v ss &> /dev/null; then
    if ss -tuln 2>/dev/null | grep -q ":3000"; then
        echo -e "${GREEN}✅ Порт 3000 слушается${NC}"
        ss -tuln 2>/dev/null | grep ":3000"
    else
        echo -e "${RED}❌ Порт 3000 НЕ слушается${NC}"
    fi
fi

# 7. Проверка health endpoint
echo ""
echo "7️⃣  Проверка health endpoint..."
HEALTH=$(curl -s -w "\nHTTP:%{http_code}" --max-time 5 http://localhost:3000/health 2>&1)
if echo "$HEALTH" | grep -q "HTTP:200"; then
    echo -e "${GREEN}✅ Health endpoint работает${NC}"
    echo "$HEALTH" | grep -v "HTTP:"
else
    echo -e "${RED}❌ Health endpoint НЕ работает${NC}"
    echo "$HEALTH"
    echo ""
    echo "Проверьте логи:"
    echo "pm2 logs reverse-proxy --lines 50 --err"
fi

# 8. Перезапуск Nginx
echo ""
echo "8️⃣  Перезапуск Nginx..."
nginx -t 2>&1 | head -3
if [ $? -eq 0 ]; then
    systemctl reload nginx
    echo -e "${GREEN}✅ Nginx перезагружен${NC}"
else
    echo -e "${RED}❌ Ошибка в конфигурации Nginx${NC}"
fi

# 9. Финальная проверка
echo ""
echo "=========================================="
echo "  РЕЗУЛЬТАТ"
echo "=========================================="
echo ""

if pm2 list | grep -q "reverse-proxy.*online"; then
    echo -e "${GREEN}✅ PM2 процесс работает${NC}"
else
    echo -e "${RED}❌ PM2 процесс НЕ работает${NC}"
    echo "Выполните: pm2 logs reverse-proxy --lines 50"
fi

if systemctl is-active --quiet nginx; then
    echo -e "${GREEN}✅ Nginx активен${NC}"
else
    echo -e "${RED}❌ Nginx НЕ активен${NC}"
fi

echo ""
echo "Если проблема сохраняется, выполните:"
echo "  ./diagnose-504.sh"
echo ""
