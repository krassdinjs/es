# Исправление SSL ошибки для Telegram Webhook

## Проблема
Ошибка: `SSL error {error:0A000086:SSL routines::certificate verify failed}`

Это означает, что SSL сертификат для домена `effllows-m50.com` не установлен или недействителен.

## Решение

### Шаг 1: Проверить SSL сертификат

```bash
# Проверить сертификат домена
openssl s_client -connect effllows-m50.com:443 -servername effllows-m50.com < /dev/null 2>/dev/null | openssl x509 -noout -dates

# Или через curl
curl -vI https://effllows-m50.com 2>&1 | grep -i "SSL\|certificate"
```

### Шаг 2: Установить/обновить SSL сертификат через certbot

```bash
# Установить сертификат для домена
certbot --nginx -d effllows-m50.com -d www.effllows-m50.com --non-interactive --agree-tos --email admin@effllows-m50.com --redirect

# Если certbot не найден, установите его:
# apt update && apt install -y certbot python3-certbot-nginx
```

### Шаг 3: Проверить nginx конфигурацию

```bash
# Проверить конфиг nginx
nginx -t

# Проверить, что есть SSL конфиг для домена
cat /etc/nginx/sites-available/effllows-m50.com | grep -i ssl

# Если конфига нет, создайте его или обновите существующий
```

### Шаг 4: Перезагрузить nginx

```bash
systemctl reload nginx
# или
systemctl restart nginx
```

### Шаг 5: Проверить SSL снова

```bash
# Проверить, что SSL работает
curl -vI https://effllows-m50.com

# Должен вернуть 200 OK без SSL ошибок
```

### Шаг 6: Обновить webhook после исправления SSL

```bash
# Удалить старый webhook
curl -X POST "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/deleteWebhook"

# Установить заново
curl -X POST "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/setWebhook?url=https://effllows-m50.com/api/telegram/webhook"

# Проверить
curl "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/getWebhookInfo"
```

## Альтернативное решение: Использовать самоподписанный сертификат (НЕ РЕКОМЕНДУЕТСЯ)

Если Let's Encrypt не работает, можно временно использовать самоподписанный сертификат, но Telegram может его не принять.

## Проверка после исправления

1. Webhook должен показывать `"last_error_message": null`
2. `pending_update_count` должен уменьшиться после отправки сообщения боту
3. Бот должен отвечать на команды
