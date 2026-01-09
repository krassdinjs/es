#!/bin/bash

# ==========================================
# СКРИПТ УСТАНОВКИ REVERSE PROXY
# Для чистого сервера (без панелей управления)
# ==========================================

set -e

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[⚠]${NC} $1"
}

log_error() {
    echo -e "${RED}[✗]${NC} $1"
}

echo ""
echo "=========================================="
echo "  УСТАНОВКА REVERSE PROXY"
echo "=========================================="
echo ""

# Проверка прав root
if [ "$EUID" -ne 0 ]; then
    log_error "Скрипт должен запускаться от root (используйте sudo)"
    exit 1
fi

# Переменные
DOMAIN="${1:-efflow-m50.com}"
APP_DIR="$(pwd)"
NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}"
NGINX_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}"

log_info "Домен: $DOMAIN"
log_info "Директория приложения: $APP_DIR"
echo ""

# ==========================================
# ЭТАП 1: УСТАНОВКА ЗАВИСИМОСТЕЙ
# ==========================================

log_info "ЭТАП 1: Установка зависимостей..."

# Определение дистрибутива
if [ -f /etc/debian_version ]; then
    log_info "Обнаружен Debian/Ubuntu"
    UPDATE_CMD="apt update"
    INSTALL_CMD="apt install -y"
elif [ -f /etc/redhat-release ]; then
    log_info "Обнаружен RedHat/CentOS"
    UPDATE_CMD="yum update -y"
    INSTALL_CMD="yum install -y"
else
    log_error "Неподдерживаемый дистрибутив"
    exit 1
fi

# Обновление пакетов
log_info "Обновление списка пакетов..."
$UPDATE_CMD

# Установка Node.js (если не установлен)
if ! command -v node &> /dev/null; then
    log_info "Установка Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    $INSTALL_CMD nodejs
else
    NODE_VERSION=$(node --version)
    log_success "Node.js уже установлен: $NODE_VERSION"
fi

# Установка PM2 (если не установлен)
if ! command -v pm2 &> /dev/null; then
    log_info "Установка PM2..."
    npm install -g pm2
else
    log_success "PM2 уже установлен"
fi

# Установка nginx (если не установлен)
if ! command -v nginx &> /dev/null; then
    log_info "Установка nginx..."
    $INSTALL_CMD nginx
else
    NGINX_VERSION=$(nginx -v 2>&1 | cut -d'/' -f2)
    log_success "Nginx уже установлен: $NGINX_VERSION"
fi

log_success "Все зависимости установлены"
echo ""

# ==========================================
# ЭТАП 2: УСТАНОВКА ПРИЛОЖЕНИЯ
# ==========================================

log_info "ЭТАП 2: Установка приложения..."

# Переход в директорию приложения
cd "$APP_DIR"

# Установка npm зависимостей
if [ -f "package.json" ]; then
    log_info "Установка npm зависимостей..."
    npm install
    log_success "Зависимости установлены"
else
    log_error "package.json не найден!"
    exit 1
fi

# Создание директории для логов
mkdir -p logs
log_success "Директория для логов создана"

log_success "Приложение установлено"
echo ""

# ==========================================
# ЭТАП 3: НАСТРОЙКА NGINX
# ==========================================

log_info "ЭТАП 3: Настройка nginx..."

# Копирование конфигурации
if [ -f "nginx.conf" ]; then
    log_info "Копирование конфигурации nginx..."
    
    # Замена домена в конфигурации
    sed "s/efflow-m50.com/$DOMAIN/g" nginx.conf > /tmp/nginx_${DOMAIN}.conf
    
    # Копирование в sites-available
    cp /tmp/nginx_${DOMAIN}.conf "$NGINX_CONF"
    rm /tmp/nginx_${DOMAIN}.conf
    
    log_success "Конфигурация скопирована: $NGINX_CONF"
else
    log_error "nginx.conf не найден!"
    exit 1
fi

# Создание симлинка в sites-enabled
if [ -L "$NGINX_ENABLED" ]; then
    log_warning "Симлинк уже существует, удаляю..."
    rm "$NGINX_ENABLED"
fi

ln -s "$NGINX_CONF" "$NGINX_ENABLED"
log_success "Симлинк создан: $NGINX_ENABLED"

# Проверка синтаксиса
log_info "Проверка синтаксиса nginx..."
if nginx -t 2>&1 | grep -q "syntax is ok"; then
    log_success "Синтаксис nginx правильный"
else
    log_error "Ошибка синтаксиса nginx:"
    nginx -t
    exit 1
fi

# Перезагрузка nginx
log_info "Перезагрузка nginx..."
systemctl reload nginx || systemctl restart nginx
log_success "Nginx перезагружен"

log_success "Nginx настроен"
echo ""

# ==========================================
# ЭТАП 4: ЗАПУСК ПРИЛОЖЕНИЯ
# ==========================================

log_info "ЭТАП 4: Запуск приложения..."

# Остановка существующего процесса (если есть)
if pm2 list | grep -q "reverse-proxy"; then
    log_info "Остановка существующего процесса..."
    pm2 stop reverse-proxy || true
    pm2 delete reverse-proxy || true
fi

# Запуск приложения
if [ -f "pm2.config.js" ]; then
    log_info "Запуск через PM2 (pm2.config.js)..."
    pm2 start pm2.config.js
else
    log_info "Запуск через PM2 (server.js)..."
    pm2 start server.js --name reverse-proxy
fi

# Сохранение конфигурации PM2
pm2 save

# Настройка автозапуска
pm2 startup systemd -u root --hp /root || true

log_success "Приложение запущено"
echo ""

# ==========================================
# ЭТАП 5: ПРОВЕРКА
# ==========================================

log_info "ЭТАП 5: Проверка работы..."

sleep 2

# Проверка Node.js
if ss -tlnp | grep -q ":3000"; then
    log_success "Node.js приложение слушает на порту 3000"
else
    log_warning "Node.js приложение не слушает на порту 3000"
fi

# Проверка nginx
if systemctl is-active --quiet nginx; then
    log_success "Nginx работает"
else
    log_error "Nginx не работает"
fi

# Проверка PM2
if pm2 list | grep -q "reverse-proxy.*online"; then
    log_success "PM2 процесс работает"
else
    log_warning "PM2 процесс может не работать"
fi

echo ""
echo "=========================================="
echo "  УСТАНОВКА ЗАВЕРШЕНА"
echo "=========================================="
echo ""
echo "Проверьте сайт: http://$DOMAIN"
echo ""
echo "Полезные команды:"
echo "  - PM2 логи: pm2 logs"
echo "  - PM2 статус: pm2 status"
echo "  - Nginx логи: tail -f /var/log/nginx/${DOMAIN}-access.log"
echo "  - Перезапуск: pm2 restart reverse-proxy"
echo ""
