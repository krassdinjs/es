/**
 * Site Status Monitor
 * Проверяет доступность сайта каждые 30 минут
 * Отправляет и закрепляет статус в Telegram
 */

require('dotenv').config();
const https = require('https');
const http = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Конфигурация прокси для обхода геоблокировки Cloudflare
const MONITOR_PROXY_URL = process.env.MONITOR_PROXY_URL || 'http://bpuser-RVrmTCf8:Fzrzq11b8xyojNfWa244_country-IE,DE@residential.bpproxy.at:1000';

// Конфигурация
const CONFIG = {
    // Telegram
    botToken: process.env.TELEGRAM_BOT_TOKEN || '8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM',
    chatId: process.env.TELEGRAM_CHAT_ID || '-1003580814172',
    
    // Сайт для мониторинга
    siteUrl: process.env.PROXY_DOMAIN ? `https://${process.env.PROXY_DOMAIN}` : 'https://m50-ietolls.com',
    siteDomain: process.env.PROXY_DOMAIN || 'm50-ietolls.com',
    
    // Интервал проверки (30 минут = 1800000 мс)
    checkInterval: 30 * 60 * 1000,
    
    // Таймаут запроса (15 секунд)
    requestTimeout: 15000,
    
    // Использовать прокси для проверки сайта (для обхода геоблокировки)
    useProxy: true,
    proxyUrl: MONITOR_PROXY_URL
};

// ID последнего закреплённого сообщения
let lastPinnedMessageId = null;

/**
 * Проверка доступности сайта
 * Использует HTTP прокси для обхода геоблокировки Cloudflare
 */
async function checkSiteStatus() {
    return new Promise((resolve) => {
        const startTime = Date.now();
        
        // Настройки запроса
        const requestOptions = {
            timeout: CONFIG.requestTimeout,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            }
        };
        
        // Добавить прокси агент если включено
        if (CONFIG.useProxy && CONFIG.proxyUrl) {
            try {
                requestOptions.agent = new HttpsProxyAgent(CONFIG.proxyUrl);
                console.log(`[Monitor] Using proxy: ${CONFIG.proxyUrl.replace(/:[^:@]+@/, ':***@')}`);
            } catch (proxyError) {
                console.error(`[Monitor] Failed to create proxy agent: ${proxyError.message}`);
            }
        }
        
        const req = https.get(CONFIG.siteUrl, requestOptions, (res) => {
            const responseTime = Date.now() - startTime;
            const statusCode = res.statusCode;
            
            // Успешные коды: 200-399
            const isAvailable = statusCode >= 200 && statusCode < 400;
            
            console.log(`[Monitor] Site check: ${statusCode} in ${responseTime}ms (proxy: ${CONFIG.useProxy})`);
            
            resolve({
                available: isAvailable,
                statusCode: statusCode,
                responseTime: responseTime,
                error: null
            });
            
            // Завершаем чтение
            res.resume();
        });
        
        req.on('error', (error) => {
            console.error(`[Monitor] Request error: ${error.message}`);
            resolve({
                available: false,
                statusCode: null,
                responseTime: null,
                error: error.message
            });
        });
        
        req.on('timeout', () => {
            req.destroy();
            console.error(`[Monitor] Request timeout after ${CONFIG.requestTimeout}ms`);
            resolve({
                available: false,
                statusCode: null,
                responseTime: null,
                error: 'Timeout'
            });
        });
    });
}

/**
 * Отправка сообщения в Telegram
 */
async function sendTelegramMessage(text) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            chat_id: CONFIG.chatId,
            text: text,
            parse_mode: 'HTML',
            disable_notification: false
        });
        
        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${CONFIG.botToken}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };
        
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
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
 * Закрепление сообщения в Telegram
 */
async function pinTelegramMessage(messageId) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            chat_id: CONFIG.chatId,
            message_id: messageId,
            disable_notification: true
        });
        
        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${CONFIG.botToken}/pinChatMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };
        
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    if (result.ok) {
                        resolve(true);
                    } else {
                        console.error('[Monitor] Pin error:', result.description);
                        resolve(false); // Не прерываем работу
                    }
                } catch (e) {
                    resolve(false);
                }
            });
        });
        
        req.on('error', () => resolve(false));
        req.write(data);
        req.end();
    });
}

/**
 * Открепление предыдущего сообщения
 */
async function unpinTelegramMessage(messageId) {
    return new Promise((resolve) => {
        const data = JSON.stringify({
            chat_id: CONFIG.chatId,
            message_id: messageId
        });
        
        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${CONFIG.botToken}/unpinChatMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };
        
        const req = https.request(options, (res) => {
            res.resume();
            res.on('end', () => resolve(true));
        });
        
        req.on('error', () => resolve(false));
        req.write(data);
        req.end();
    });
}

/**
 * Форматирование времени
 */
function formatDateTime() {
    const now = new Date();
    const options = {
        timeZone: 'Europe/Dublin',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    };
    return now.toLocaleString('ru-RU', options);
}

/**
 * Форматирование статус-сообщения
 */
function formatStatusMessage(status) {
    const time = formatDateTime();
    const statusEmoji = status.available ? '🟢' : '🔴';
    const statusText = status.available ? 'ДОСТУПЕН' : 'НЕДОСТУПЕН';
    
    let message = `
<b>📊 СТАТУС САЙТА</b>

${statusEmoji} <b>Статус:</b> ${statusText}
🌐 <b>Домен:</b> ${CONFIG.siteDomain}
🔗 <b>URL:</b> ${CONFIG.siteUrl}
🕐 <b>Проверка:</b> ${time}`;

    if (status.available) {
        message += `
⚡ <b>Время ответа:</b> ${status.responseTime}ms
📡 <b>HTTP код:</b> ${status.statusCode}`;
    } else {
        message += `
❌ <b>Ошибка:</b> ${status.error || `HTTP ${status.statusCode}`}`;
    }
    
    message += `

<i>Следующая проверка через 30 минут</i>`;
    
    return message;
}

/**
 * Основная функция мониторинга
 */
async function runMonitor() {
    console.log(`[Monitor] ${formatDateTime()} - Проверка сайта ${CONFIG.siteUrl}...`);
    
    try {
        // Проверяем сайт
        const status = await checkSiteStatus();
        console.log(`[Monitor] Результат:`, status);
        
        // Формируем сообщение
        const message = formatStatusMessage(status);
        
        // Отправляем в Telegram
        const sentMessage = await sendTelegramMessage(message);
        console.log(`[Monitor] Сообщение отправлено, ID: ${sentMessage.message_id}`);
        
        // Открепляем предыдущее сообщение (если есть)
        if (lastPinnedMessageId) {
            await unpinTelegramMessage(lastPinnedMessageId);
            console.log(`[Monitor] Старое сообщение ${lastPinnedMessageId} откреплено`);
        }
        
        // Закрепляем новое сообщение
        const pinned = await pinTelegramMessage(sentMessage.message_id);
        if (pinned) {
            lastPinnedMessageId = sentMessage.message_id;
            console.log(`[Monitor] Сообщение ${sentMessage.message_id} закреплено`);
        } else {
            console.log(`[Monitor] Не удалось закрепить (бот должен быть админом чата)`);
        }
        
    } catch (error) {
        console.error(`[Monitor] Ошибка:`, error.message);
    }
}

/**
 * Запуск мониторинга
 */
function startMonitor() {
    console.log('='.repeat(50));
    console.log('[Monitor] 🚀 Site Status Monitor Started');
    console.log(`[Monitor] Домен: ${CONFIG.siteDomain}`);
    console.log(`[Monitor] Интервал: ${CONFIG.checkInterval / 60000} минут`);
    console.log(`[Monitor] Chat ID: ${CONFIG.chatId}`);
    console.log('='.repeat(50));
    
    // Первая проверка сразу
    runMonitor();
    
    // Затем каждые 30 минут
    setInterval(runMonitor, CONFIG.checkInterval);
}

// Запуск
startMonitor();
