# Исправление Telegram Webhook

## Проблема
В команде curl был неправильный URL - не хватало `https://` перед доменом.

## Правильная команда для установки webhook:

```bash
# Замените YOUR_DOMAIN на ваш реальный домен (например: eflows-m50.com)
curl -X POST "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/setWebhook?url=https://YOUR_DOMAIN/api/telegram/webhook"
```

## Для вашего случая (если домен: effllows-m50.com):

```bash
curl -X POST "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/setWebhook?url=https://effllows-m50.com/api/telegram/webhook"
```

## Проверка webhook:

```bash
# Проверить текущий webhook
curl "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/getWebhookInfo"
```

## Если webhook не работает:

1. Проверьте, что домен доступен:
   ```bash
   curl https://effllows-m50.com/health
   ```

2. Проверьте, что nginx правильно проксирует запросы:
   ```bash
   curl https://effllows-m50.com/api/telegram/webhook
   ```

3. Удалите и установите webhook заново:
   ```bash
   # Удалить
   curl -X POST "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/deleteWebhook"
   
   # Установить заново
   curl -X POST "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/setWebhook?url=https://effllows-m50.com/api/telegram/webhook"
   ```

4. Проверьте логи сервера:
   ```bash
   pm2 logs reverse-proxy --lines 50
   ```

## Важно:

- URL должен начинаться с `https://`
- Домен должен быть доступен и указывать на ваш сервер
- Порт 3000 должен быть открыт (или nginx должен проксировать на него)
