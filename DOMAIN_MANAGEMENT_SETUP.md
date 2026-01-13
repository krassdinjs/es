# Настройка управления доменами через Telegram бота

## Требования

1. Node.js сервер с установленным nginx и certbot
2. Telegram бот токен
3. Хостер API токен (Netlify Personal Access Token)
4. IP адрес сервера

## Настройка .env

Добавьте следующие переменные в файл `.env`:

```bash
# Telegram Bot
TELEGRAM_BOT_TOKEN=8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM
TELEGRAM_CHAT_ID=-1003622716214
TELEGRAM_ADMIN_CHAT_ID=-1003536411546

# Хостер API (Netlify)
HOSTER_API_TOKEN=nfp_Y3zpouopEDAPzZk2f5kqD2fBeT7c6qftef45
NETLIFY_API_TOKEN=nfp_Y3zpouopEDAPzZk2f5kqD2fBeT7c6qftef45

# Server IP
SERVER_IP=213.176.79.129

# SSL Email для certbot
SSL_EMAIL=your-email@example.com
```

## Настройка Telegram Webhook

После запуска сервера установите webhook:

```bash
curl -X POST "https://api.telegram.org/bot8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM/setWebhook?url=https://your-domain.com/api/telegram/webhook"
```

## Использование

### Команды бота:

- `/start` или `/menu` - Главное меню
- `/domains` - Список доменов
- `/sync` - Синхронизировать с хостером
- `/info` - Информация о системе

### Управление через кнопки:

1. **Главное меню** - выбор действия
2. **Список доменов** - просмотр и переключение доменов
3. **Информация о домене** - детальная информация и переключение
4. **Синхронизация** - обновление списка доменов из хостера

## Автоматические функции

1. **Синхронизация доменов** - каждые 30 минут автоматически синхронизируется список доменов с хостером
2. **SSL сертификаты** - автоматически получаются через certbot при смене домена
3. **DNS записи** - автоматически добавляются/удаляются при переключении доменов
4. **Nginx конфиг** - автоматически создается/обновляется при смене домена
5. **Перезапуск сервера** - автоматически перезапускается через PM2 или systemd

## Процесс переключения домена

1. Пользователь выбирает домен в боте
2. Система удаляет A-запись у старого домена
3. Создается/обновляется nginx конфиг для нового домена
4. Получается SSL сертификат через certbot
5. Добавляется A-запись для нового домена
6. Обновляется .env файл
7. Перезапускается сервер

## Структура domains.json

```json
{
  "domains": [
    {
      "domain": "example.com",
      "status": "active",
      "hosterZoneId": "zone_abc123",
      "dnsRecordId": "record_xyz789",
      "lastSwitched": "2026-01-11T12:00:00Z",
      "createdAt": "2026-01-11T00:00:00Z"
    }
  ],
  "currentDomain": "example.com",
  "lastSync": "2026-01-11T12:00:00Z"
}
```

## Требования к серверу

- nginx установлен и настроен
- certbot установлен
- Права на выполнение команд nginx и certbot
- Доступ к файлу `/etc/nginx/sites-available/`
- PM2 или systemd для управления процессом

## Безопасность

- `.env` файл должен быть в `.gitignore`
- Telegram webhook должен быть защищен (можно добавить проверку токена)
- API endpoints должны быть защищены (можно добавить авторизацию)
