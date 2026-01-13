#!/bin/bash

echo "=========================================="
echo "  ДИАГНОСТИКА ОШИБКИ 504 GATEWAY TIMEOUT"
echo "=========================================="
echo ""

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 1. Проверка PM2 статуса
echo "1️⃣  ПРОВЕРКА PM2"
echo "----------------"
pm2 status
echo ""

# 2. Проверка логов PM2 на ошибки
echo "2️⃣  ПОСЛЕДНИЕ ОШИБКИ В ЛОГАХ PM2"
echo "----------------"
pm2 logs reverse-proxy --lines 30 --err --nostream | tail -20
echo ""

# 3. Проверка, слушает ли порт 3000
echo "3️⃣  ПРОВЕРКА ПОРТА 3000"
echo "----------------"
if command -v netstat &> /dev/null; then
    PORT_CHECK=$(netstat -tuln 2>/dev/null | grep ":3000" || echo "")
elif command -v ss &> /dev/null; then
    PORT_CHECK=$(ss -tuln 2>/dev/null | grep ":3000" || echo "")
else
    PORT_CHECK=""
fi

if [ -z "$PORT_CHECK" ]; then
    echo -e "${RED}❌ Порт 3000 НЕ слушается${NC}"
    echo "Node.js приложение не запущено или не слушает порт 3000"
else
    echo -e "${GREEN}✅ Порт 3000 слушается${NC}"
    echo "$PORT_CHECK"
fi
echo ""

# 4. Проверка health endpoint напрямую
echo "4️⃣  ПРОВЕРКА HEALTH ENDPOINT (localhost:3000)"
echo "----------------"
HEALTH_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}\nTIME:%{time_total}" --max-time 5 http://localhost:3000/health 2>&1 || echo "ERROR")
if echo "$HEALTH_RESPONSE" | grep -q "HTTP_CODE:200"; then
    echo -e "${GREEN}✅ Health endpoint отвечает${NC}"
    echo "$HEALTH_RESPONSE" | grep -v "HTTP_CODE\|TIME"
else
    echo -e "${RED}❌ Health endpoint НЕ отвечает${NC}"
    echo "$HEALTH_RESPONSE"
fi
echo ""

# 5. Проверка процессов Node.js
echo "5️⃣  ПРОЦЕССЫ NODE.JS"
echo "----------------"
NODE_PROCESSES=$(ps aux | grep -E "node|pm2" | grep -v grep || echo "")
if [ -z "$NODE_PROCESSES" ]; then
    echo -e "${RED}❌ Нет запущенных процессов Node.js${NC}"
else
    echo -e "${GREEN}✅ Найдены процессы Node.js:${NC}"
    echo "$NODE_PROCESSES"
fi
echo ""

# 6. Проверка .env файла
echo "6️⃣  ПРОВЕРКА .ENV ФАЙЛА"
echo "----------------"
cd ~/reverse-proxy || cd /root/reverse-proxy || exit 1

if [ -f ".env" ]; then
    echo -e "${GREEN}✅ .env файл существует${NC}"
    echo "Ключевые переменные:"
    grep -E "CUSTOM_DOMAIN|HOSTER_API_TOKEN|SERVER_IP|PORT|HOST" .env | head -10
else
    echo -e "${RED}❌ .env файл НЕ найден${NC}"
fi
echo ""

# 7. Проверка Nginx конфигурации
echo "7️⃣  ПРОВЕРКА NGINX"
echo "----------------"
if systemctl is-active --quiet nginx; then
    echo -e "${GREEN}✅ Nginx активен${NC}"
else
    echo -e "${RED}❌ Nginx НЕ активен${NC}"
fi

echo "Проверка конфигурации Nginx:"
nginx -t 2>&1 | head -5
echo ""

# 8. Проверка логов Nginx на ошибки
echo "8️⃣  ПОСЛЕДНИЕ ОШИБКИ В ЛОГАХ NGINX"
echo "----------------"
if [ -f "/var/log/nginx/effllows-m50.com-error.log" ]; then
    tail -20 /var/log/nginx/effllows-m50.com-error.log
else
    echo "Файл логов не найден"
fi
echo ""

# 9. Попытка запуска Node.js вручную (тест)
echo "9️⃣  ТЕСТ ЗАПУСКА NODE.JS"
echo "----------------"
echo "Проверка синтаксиса server.js..."
if node -c server.js 2>&1; then
    echo -e "${GREEN}✅ Синтаксис server.js корректен${NC}"
else
    echo -e "${RED}❌ Ошибка синтаксиса в server.js${NC}"
fi
echo ""

# 10. Проверка зависимостей
echo "🔟 ПРОВЕРКА ЗАВИСИМОСТЕЙ"
echo "----------------"
if [ -f "package.json" ]; then
    if [ -d "node_modules" ]; then
        echo -e "${GREEN}✅ node_modules существует${NC}"
        MISSING_DEPS=$(node -e "const pkg=require('./package.json'); const fs=require('fs'); const missing=Object.keys(pkg.dependencies||{}).filter(d=>!fs.existsSync('node_modules/'+d)); console.log(missing.join('\\n'))" 2>/dev/null || echo "")
        if [ -z "$MISSING_DEPS" ]; then
            echo "Все зависимости установлены"
        else
            echo -e "${YELLOW}⚠️  Отсутствующие зависимости:${NC}"
            echo "$MISSING_DEPS"
        fi
    else
        echo -e "${RED}❌ node_modules НЕ найден${NC}"
        echo "Выполните: npm install"
    fi
else
    echo -e "${RED}❌ package.json не найден${NC}"
fi
echo ""

# 11. Рекомендации
echo "=========================================="
echo "  РЕКОМЕНДАЦИИ"
echo "=========================================="
echo ""

if [ -z "$PORT_CHECK" ]; then
    echo -e "${YELLOW}⚠️  ПРОБЛЕМА: Порт 3000 не слушается${NC}"
    echo ""
    echo "Попробуйте:"
    echo "1. pm2 delete all"
    echo "2. cd ~/reverse-proxy"
    echo "3. pm2 start pm2.config.js --update-env"
    echo "4. pm2 logs reverse-proxy --lines 50"
    echo ""
elif ! echo "$HEALTH_RESPONSE" | grep -q "HTTP_CODE:200"; then
    echo -e "${YELLOW}⚠️  ПРОБЛЕМА: Health endpoint не отвечает${NC}"
    echo ""
    echo "Попробуйте:"
    echo "1. pm2 restart reverse-proxy --update-env"
    echo "2. sleep 5"
    echo "3. curl http://localhost:3000/health"
    echo "4. pm2 logs reverse-proxy --lines 50"
    echo ""
else
    echo -e "${GREEN}✅ Node.js приложение работает${NC}"
    echo ""
    echo "Если сайт все еще не работает, проверьте:"
    echo "1. Nginx конфигурацию: nginx -t"
    echo "2. Логи Nginx: tail -50 /var/log/nginx/effllows-m50.com-error.log"
    echo "3. Перезапустите Nginx: systemctl reload nginx"
    echo ""
fi

echo "=========================================="
