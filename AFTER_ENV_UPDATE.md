# Инструкция после обновления .env файла

## Шаг 1: Обновление кода с GitHub

```bash
cd ~/reverse-proxy
git pull origin main
```

## Шаг 2: Установка зависимостей (если нужно)

```bash
npm install
```

## Шаг 3: Настройка Telegram Webhook

```bash
# Замените YOUR_DOMAIN на ваш текущий домен (например: eflows-m50.com)
curl -X POST "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/setWebhook?url=https://YOUR_DOMAIN.com/api/telegram/webhook"

# Проверить webhook
curl "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/getWebhookInfo"
```

**Важно:** Замените `YOUR_DOMAIN` на ваш реальный домен!

## Шаг 4: Перезапуск сервера

```bash
# Если используете PM2
pm2 restart reverse-proxy
# или
pm2 restart all

# Проверить статус
pm2 status

# Посмотреть логи
pm2 logs reverse-proxy --lines 50
```

## Шаг 5: Проверка работы

### 5.1. Проверить, что сервер запущен:

```bash
# Проверить порт
netstat -tulpn | grep 3000
# или
ss -tulpn | grep 3000

# Проверить health endpoint
curl http://localhost:3000/health
```

### 5.2. Проверить Telegram бота:

1. Откройте Telegram
2. Найдите вашего бота (токен: `8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM`)
3. Отправьте команду `/start` или `/menu`
4. Должно появиться главное меню с кнопками

### 5.3. Проверить синхронизацию доменов:

1. В Telegram боте нажмите кнопку "🔄 Синхронизировать"
2. Должны появиться домены из хостера (Netlify)
3. Если домены не появились, проверьте:
   - `HOSTER_API_TOKEN` в .env
   - Права доступа токена в Netlify
   - Логи сервера

## Шаг 6: Проверка логов

```bash
# Логи PM2
pm2 logs reverse-proxy --lines 100

# Или в реальном времени
pm2 logs reverse-proxy

# Проверить ошибки
pm2 logs reverse-proxy --err --lines 50
```

## Шаг 7: Тестирование переключения домена

1. В Telegram боте:
   - Нажмите "🌐 Список доменов"
   - Выберите доступный домен
   - Нажмите "🔄 Переключить"

2. Проверьте логи:
   ```bash
   pm2 logs reverse-proxy --lines 100
   ```

3. Проверьте, что:
   - DNS запись обновилась в Netlify
   - SSL сертификат получен (если используется nginx)
   - Nginx конфиг обновлен
   - Сервер перезапустился

## Возможные проблемы

### Проблема: Webhook не работает

```bash
# Удалить webhook и установить заново
curl -X POST "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/deleteWebhook"
curl -X POST "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/setWebhook?url=https://YOUR_DOMAIN.com/api/telegram/webhook"
```

### Проблема: Домены не синхронизируются

```bash
# Проверить токен хостера
curl -H "Authorization: Bearer nfp_Y3zpouopEDAPzZk2f5kqD2fBeT7c6qftef45" \
  https://api.netlify.com/api/v1/dns_zones

# Проверить логи
pm2 logs reverse-proxy | grep DomainManager
```

### Проблема: Сервер не запускается

```bash
# Проверить ошибки
pm2 logs reverse-proxy --err

# Проверить .env файл
cat .env | grep -E "TELEGRAM|HOSTER|SERVER_IP"

# Проверить синтаксис .env
node -e "require('dotenv').config(); console.log('OK')"
```

## Быстрая команда для всего сразу

```bash
cd ~/reverse-proxy && \
git pull origin main && \
npm install && \
pm2 restart reverse-proxy && \
pm2 logs reverse-proxy --lines 20
```

## Проверка конфигурации

```bash
# Проверить, что все переменные загружены
node -e "
require('dotenv').config();
console.log('TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN ? 'OK' : 'MISSING');
console.log('TELEGRAM_CHAT_ID:', process.env.TELEGRAM_CHAT_ID);
console.log('TELEGRAM_ADMIN_CHAT_ID:', process.env.TELEGRAM_ADMIN_CHAT_ID);
console.log('HOSTER_API_TOKEN:', process.env.HOSTER_API_TOKEN ? 'OK' : 'MISSING');
console.log('SERVER_IP:', process.env.SERVER_IP);
"
```

---

**После выполнения всех шагов система управления доменами должна работать!**
