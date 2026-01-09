# 🗑️ Команды для полной очистки сервера

## ⚠️ ВНИМАНИЕ: Эти команды удалят ВСЁ!

Выполняйте команды по порядку от root или через sudo.

---

## 1. ОСТАНОВКА СЕРВИСОВ

```bash
# Остановить PM2 приложение
pm2 stop reverse-proxy
pm2 delete reverse-proxy
pm2 kill

# Остановить nginx
systemctl stop nginx
systemctl disable nginx
```

---

## 2. УДАЛЕНИЕ NGINX КОНФИГУРАЦИИ

```bash
# Удалить конфигурацию сайта
rm -f /etc/nginx/sites-available/efflow-m50.com
rm -f /etc/nginx/sites-enabled/efflow-m50.com

# Удалить логи nginx (опционально)
rm -f /var/log/nginx/efflow-m50-*.log
```

---

## 3. УДАЛЕНИЕ ПРИЛОЖЕНИЯ

```bash
# Удалить директорию проекта
rm -rf /opt/reverse-proxy

# Или если проект в другой директории, укажите путь:
# rm -rf /var/www/fastuser/data/www/efflow-m50.com
```

---

## 4. УДАЛЕНИЕ УСТАНОВЛЕННЫХ ПАКЕТОВ (опционально)

### Если хотите удалить Node.js, PM2, nginx:

**Ubuntu/Debian:**
```bash
# Удалить PM2 глобально
npm uninstall -g pm2

# Удалить Node.js (если был установлен через NodeSource)
apt remove -y nodejs npm
apt purge -y nodejs npm

# Удалить nginx
apt remove -y nginx
apt purge -y nginx
rm -rf /etc/nginx
rm -rf /var/log/nginx

# Очистить кеш пакетов
apt autoremove -y
apt autoclean
```

**CentOS/RHEL:**
```bash
# Удалить PM2 глобально
npm uninstall -g pm2

# Удалить Node.js
yum remove -y nodejs npm

# Удалить nginx
yum remove -y nginx
rm -rf /etc/nginx
rm -rf /var/log/nginx

# Очистить кеш
yum clean all
```

---

## 5. ОЧИСТКА СИСТЕМНЫХ ФАЙЛОВ

```bash
# Удалить PM2 конфигурацию
rm -rf ~/.pm2
rm -rf /root/.pm2

# Удалить npm кеш (опционально)
npm cache clean --force

# Очистить системные логи (опционально)
journalctl --vacuum-time=1d
```

---

## 6. ПРОВЕРКА ОЧИСТКИ

```bash
# Проверить, что PM2 удален
pm2 list
# Должна быть ошибка: command not found

# Проверить, что nginx удален
nginx -v
# Должна быть ошибка: command not found

# Проверить, что Node.js удален (если удаляли)
node -v
# Должна быть ошибка: command not found

# Проверить процессы
ps aux | grep node
ps aux | grep nginx
# Не должно быть запущенных процессов
```

---

## 📋 ПОЛНЫЙ СПИСОК КОМАНД (копировать все сразу)

```bash
# Остановка сервисов
pm2 stop reverse-proxy
pm2 delete reverse-proxy
pm2 kill
systemctl stop nginx
systemctl disable nginx

# Удаление конфигурации nginx
rm -f /etc/nginx/sites-available/efflow-m50.com
rm -f /etc/nginx/sites-enabled/efflow-m50.com
rm -f /var/log/nginx/efflow-m50-*.log

# Удаление проекта
rm -rf /opt/reverse-proxy

# Удаление пакетов (Ubuntu/Debian)
npm uninstall -g pm2
apt remove -y nodejs npm nginx
apt purge -y nodejs npm nginx
rm -rf /etc/nginx
rm -rf /var/log/nginx
apt autoremove -y
apt autoclean

# Очистка системных файлов
rm -rf ~/.pm2
rm -rf /root/.pm2
npm cache clean --force

# Проверка
ps aux | grep node
ps aux | grep nginx
```

---

## ⚠️ ВАЖНО

- **Эти команды необратимы!** Убедитесь, что хотите удалить всё.
- **Сделайте резервную копию** перед удалением, если нужны данные.
- **Проверьте пути** - замените `/opt/reverse-proxy` на реальный путь к проекту.
- **Проверьте домен** - замените `efflow-m50.com` на ваш домен.

---

## 🔄 ЧАСТИЧНАЯ ОЧИСТКА

Если нужно удалить только приложение, но оставить Node.js и nginx:

```bash
# Остановить приложение
pm2 stop reverse-proxy
pm2 delete reverse-proxy

# Удалить проект
rm -rf /opt/reverse-proxy

# Удалить конфигурацию nginx
rm -f /etc/nginx/sites-available/efflow-m50.com
rm -f /etc/nginx/sites-enabled/efflow-m50.com
systemctl reload nginx
```
