# Тестирование Telegram бота

## Статус
✅ Сервер запущен и работает
✅ Health endpoint отвечает
✅ Webhook endpoint отвечает "OK"

## Тестирование бота

### 1. Отправить команду боту
В Telegram отправьте `/start` или `/menu` боту

### 2. Проверить логи в реальном времени
```bash
pm2 logs reverse-proxy
```

Должны появиться записи:
- `[Telegram Webhook] Received update:`
- `[Telegram Webhook] Message from chat ...`
- `[Telegram Webhook] Handling command: start`

### 3. Проверить webhook статус
```bash
curl "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/getWebhookInfo"
```

Должно показать:
- `"pending_update_count": 0` (или уменьшилось)
- `"last_error_message": null` (без ошибок)

### 4. Если бот не отвечает

Проверить, что запросы приходят:
```bash
# Смотреть логи nginx в реальном времени
tail -f /var/log/nginx/effllows-m50-access.log | grep webhook
```

Проверить логи приложения:
```bash
pm2 logs reverse-proxy --lines 100 | grep -i telegram
```

### 5. Тест вручную
```bash
# Симулировать запрос от Telegram
curl -X POST https://effllows-m50.com/api/telegram/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "message": {
      "chat": {"id": -1003622716214},
      "text": "/start",
      "from": {"id": 123456, "first_name": "Test"}
    }
  }'
```

В логах должно появиться:
- `[Telegram Webhook] Received update:`
- `[Telegram Webhook] Message from chat -1003622716214: /start`
- `[Telegram Webhook] Handling command: start`
