# Исправление пустого webhook URL

## Проблема
Webhook URL пустой (`"url":""`), но есть 14 ожидающих обновлений.

## Решение

### 1. Установить webhook заново

```bash
curl -X POST "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/setWebhook?url=https://effllows-m50.com/api/telegram/webhook"
```

### 2. Проверить webhook

```bash
curl "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/getWebhookInfo"
```

Должно показать:
- `"url": "https://effllows-m50.com/api/telegram/webhook"`
- `"pending_update_count": 0` (или уменьшится после обработки)
- `"last_error_message": null`

### 3. Проверить логи

```bash
pm2 logs reverse-proxy
```

После установки webhook Telegram автоматически отправит все ожидающие обновления (14 штук).

### 4. Отправить команду боту

В Telegram отправьте `/start` боту - должно появиться главное меню.
