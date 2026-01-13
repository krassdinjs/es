# Разрешение конфликта в .env

## Проблема
Git stash pop создал конфликт в .env файле.

## Решение

### Вариант 1: Использовать локальную версию .env (рекомендуется)

```bash
cd ~/reverse-proxy

# Использовать локальную версию .env (вашу текущую)
git checkout --ours .env
git add .env
git commit -m "Resolve .env conflict - keep local version"
```

### Вариант 2: Использовать версию из репозитория

```bash
cd ~/reverse-proxy

# Использовать версию из репозитория
git checkout --theirs .env
git add .env
git commit -m "Resolve .env conflict - use repo version"

# Затем обновить .env вручную с правильными значениями
nano .env
```

### Вариант 3: Вручную разрешить конфликт

```bash
cd ~/reverse-proxy

# Открыть .env и найти конфликтные маркеры
nano .env

# Удалить строки:
# <<<<<<< Updated upstream
# =======
# >>>>>>> Stashed changes

# Оставить нужные значения
# Сохранить (Ctrl+O, Enter, Ctrl+X)

git add .env
git commit -m "Resolve .env conflict manually"
```

## После разрешения конфликта

```bash
# 1. Проверить, что конфликт разрешен
git status

# 2. Перезапустить сервер с обновленными переменными
pm2 restart reverse-proxy --update-env

# 3. Проверить логи
pm2 logs reverse-proxy --lines 50

# 4. Проверить health endpoint
curl http://localhost:3000/health

# 5. Проверить webhook
curl -X POST https://effllows-m50.com/api/telegram/webhook -H "Content-Type: application/json" -d '{"test":"data"}'
```
