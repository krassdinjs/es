#!/bin/bash

echo "=========================================="
echo "  ПЕРЕЗАПУСК СЕРВИСОВ"
echo "=========================================="
echo ""

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Функция для проверки статуса
check_status() {
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ $1${NC}"
    else
        echo -e "${RED}❌ $1${NC}"
    fi
}

# 1. Проверка текущего статуса
echo "📊 Проверка текущего статуса..."
echo ""

echo "PM2 процессы:"
pm2 status
echo ""

echo "Nginx статус:"
systemctl status nginx --no-pager -l | head -5
echo ""

# 2. Проверка порта 3000
echo "🔍 Проверка порта 3000..."
if netstat -tuln 2>/dev/null | grep -q ":3000" || ss -tuln 2>/dev/null | grep -q ":3000"; then
    echo -e "${GREEN}✅ Порт 3000 занят${NC}"
else
    echo -e "${YELLOW}⚠️  Порт 3000 свободен${NC}"
fi
echo ""

# 3. Перезапуск PM2
echo "🔄 Перезапуск PM2..."
cd ~/reverse-proxy || cd /root/reverse-proxy || exit 1

# Остановка всех процессов
pm2 stop all 2>/dev/null
sleep 2

# Удаление всех процессов
pm2 delete all 2>/dev/null
sleep 1

# Запуск через pm2.config.js или server.js
if [ -f "pm2.config.js" ]; then
    echo "Запуск через pm2.config.js..."
    pm2 start pm2.config.js --update-env
    check_status "PM2 запущен через pm2.config.js"
else
    echo "Запуск через server.js..."
    pm2 start server.js --name reverse-proxy --update-env
    check_status "PM2 запущен через server.js"
fi

# Сохранение конфигурации PM2
pm2 save
echo ""

# 4. Проверка Node.js приложения
echo "⏳ Ожидание запуска Node.js (5 секунд)..."
sleep 5

echo "🔍 Проверка health endpoint..."
HEALTH_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health 2>/dev/null || echo "000")

if [ "$HEALTH_RESPONSE" = "200" ]; then
    echo -e "${GREEN}✅ Node.js приложение работает (HTTP $HEALTH_RESPONSE)${NC}"
    curl -s http://localhost:3000/health
    echo ""
else
    echo -e "${RED}❌ Node.js приложение не отвечает (HTTP $HEALTH_RESPONSE)${NC}"
    echo "Проверьте логи: pm2 logs reverse-proxy --lines 50"
fi
echo ""

# 5. Проверка конфигурации Nginx
echo "🔍 Проверка конфигурации Nginx..."
nginx -t
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Конфигурация Nginx корректна${NC}"
else
    echo -e "${RED}❌ Ошибка в конфигурации Nginx${NC}"
    echo "Исправьте ошибки перед перезапуском!"
    exit 1
fi
echo ""

# 6. Перезапуск Nginx
echo "🔄 Перезапуск Nginx..."
systemctl reload nginx
check_status "Nginx перезагружен"

# Альтернативный способ, если reload не работает
if ! systemctl is-active --quiet nginx; then
    echo "Попытка полного перезапуска Nginx..."
    systemctl restart nginx
    check_status "Nginx перезапущен"
fi
echo ""

# 7. Финальная проверка
echo "=========================================="
echo "  ФИНАЛЬНАЯ ПРОВЕРКА"
echo "=========================================="
echo ""

echo "📊 Статус PM2:"
pm2 status
echo ""

echo "📊 Статус Nginx:"
systemctl is-active nginx && echo -e "${GREEN}✅ Nginx активен${NC}" || echo -e "${RED}❌ Nginx не активен${NC}"
echo ""

echo "🔍 Проверка порта 3000:"
if netstat -tuln 2>/dev/null | grep -q ":3000" || ss -tuln 2>/dev/null | grep -q ":3000"; then
    echo -e "${GREEN}✅ Порт 3000 слушается${NC}"
    netstat -tuln 2>/dev/null | grep ":3000" || ss -tuln 2>/dev/null | grep ":3000"
else
    echo -e "${RED}❌ Порт 3000 не слушается${NC}"
fi
echo ""

echo "🔍 Проверка health через Nginx:"
HEALTH_NGINX=$(curl -s -o /dev/null -w "%{http_code}" https://effllows-m50.com/health 2>/dev/null || curl -s -o /dev/null -w "%{http_code}" http://effllows-m50.com/health 2>/dev/null || echo "000")
if [ "$HEALTH_NGINX" = "200" ]; then
    echo -e "${GREEN}✅ Health endpoint доступен через Nginx (HTTP $HEALTH_NGINX)${NC}"
else
    echo -e "${YELLOW}⚠️  Health endpoint недоступен через Nginx (HTTP $HEALTH_NGINX)${NC}"
    echo "Это может быть нормально, если DNS еще не обновился"
fi
echo ""

echo "=========================================="
echo "  ПЕРЕЗАПУСК ЗАВЕРШЕН"
echo "=========================================="
echo ""
echo "Полезные команды:"
echo "  - PM2 логи: pm2 logs reverse-proxy --lines 100"
echo "  - PM2 статус: pm2 status"
echo "  - Nginx логи: tail -f /var/log/nginx/effllows-m50.com-error.log"
echo "  - Проверка порта: netstat -tuln | grep 3000"
echo "  - Health check: curl http://localhost:3000/health"
echo ""
