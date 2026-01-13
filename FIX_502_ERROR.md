# Исправление 502 Bad Gateway

## Проблема
Nginx получает 502 Bad Gateway, что означает, что он не может подключиться к Node.js на порту 3000.

## Решение

### Шаг 1: Решить проблему с git pull

```bash
# Сохранить изменения в .env
cd ~/reverse-proxy
git stash

# Или закоммитить .env (если хотите сохранить изменения)
# git add .env
# git commit -m "Local .env changes"

# Теперь обновить код
git pull origin main

# Восстановить .env (если использовали stash)
git stash pop
```

### Шаг 2: Проверить, что Node.js сервер запущен

```bash
# Проверить статус PM2
pm2 status

# Проверить, что порт 3000 слушается
netstat -tulpn | grep 3000
# или
ss -tulpn | grep 3000

# Проверить логи на ошибки
pm2 logs reverse-proxy --err --lines 50
```

### Шаг 3: Проверить логи приложения

```bash
# Проверить последние логи
pm2 logs reverse-proxy --lines 100

# Проверить, есть ли ошибки запуска
pm2 logs reverse-proxy --err
```

### Шаг 4: Если сервер не запустился, перезапустить

```bash
# Остановить
pm2 stop reverse-proxy

# Удалить из PM2
pm2 delete reverse-proxy

# Запустить заново
cd ~/reverse-proxy
pm2 start server.js --name reverse-proxy

# Или использовать конфиг
pm2 start pm2.config.js

# Сохранить конфигурацию
pm2 save
```

### Шаг 5: Проверить health endpoint напрямую

```bash
# Проверить напрямую Node.js (должен работать)
curl http://localhost:3000/health

# Проверить через nginx (должен работать)
curl https://effllows-m50.com/health
```

### Шаг 6: Проверить nginx конфиг

```bash
# Проверить, что nginx правильно проксирует на порт 3000
cat /etc/nginx/sites-available/effllows-m50.com | grep "proxy_pass"

# Должно быть: proxy_pass http://127.0.0.1:3000;
```

### Шаг 7: Если проблема сохраняется

```bash
# Проверить, не занят ли порт 3000 другим процессом
lsof -i :3000

# Проверить firewall
ufw status

# Перезапустить nginx
systemctl restart nginx

# Перезапустить PM2
pm2 restart all
```
