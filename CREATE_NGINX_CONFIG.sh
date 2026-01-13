#!/bin/bash

# Создание nginx конфига для домена effllows-m50.com

DOMAIN="effllows-m50.com"
NGINX_AVAILABLE="/etc/nginx/sites-available/${DOMAIN}"
NGINX_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}"

echo "Создание nginx конфига для ${DOMAIN}..."

# Создать конфиг
cat > ${NGINX_AVAILABLE} << 'EOF'
# HTTP - редирект на HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name effllows-m50.com www.effllows-m50.com;

    # Let's Encrypt verification
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Редирект на HTTPS
    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name effllows-m50.com www.effllows-m50.com;

    # SSL сертификаты
    ssl_certificate /etc/letsencrypt/live/effllows-m50.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/effllows-m50.com/privkey.pem;
    
    # SSL настройки
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Логи
    access_log /var/log/nginx/effllows-m50-access.log;
    error_log /var/log/nginx/effllows-m50-error.log;

    # Прокси на Node.js
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $server_name;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }

    # Health check
    location /health {
        access_log off;
        proxy_pass http://127.0.0.1:3000/health;
    }
}
EOF

echo "Конфиг создан: ${NGINX_AVAILABLE}"

# Создать симлинк
if [ ! -L ${NGINX_ENABLED} ]; then
    ln -s ${NGINX_AVAILABLE} ${NGINX_ENABLED}
    echo "Симлинк создан: ${NGINX_ENABLED}"
fi

# Проверить конфиг
echo "Проверка конфигурации nginx..."
nginx -t

if [ $? -eq 0 ]; then
    echo "✅ Конфигурация nginx корректна"
    echo "Перезагрузка nginx..."
    systemctl reload nginx
    echo "✅ Nginx перезагружен"
else
    echo "❌ Ошибка в конфигурации nginx"
    exit 1
fi

echo ""
echo "✅ Готово! Теперь нужно получить SSL сертификат:"
echo "certbot --nginx -d effllows-m50.com -d www.effllows-m50.com --non-interactive --agree-tos --email admin@effllows-m50.com --redirect"
