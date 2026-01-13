const https = require('https');
const domainManager = require('./domain-manager');
const logger = require('./logger');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM';
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '-1003536411546';

class TelegramDomainBot {
  constructor() {
    this.setupWebhook();
    // Автоматическая синхронизация каждые 30 минут
    setInterval(() => {
      this.autoSync();
    }, 30 * 60 * 1000);
  }

  async autoSync() {
    try {
      await domainManager.syncWithHoster();
      logger.info('[TelegramDomainBot] Auto-sync completed');
    } catch (error) {
      logger.error('[TelegramDomainBot] Auto-sync error:', error);
    }
  }

  async sendMessage(chatId, text, options = {}) {
    return new Promise((resolve, reject) => {
      const payload = {
        chat_id: chatId,
        text,
        parse_mode: 'HTML'
      };

      // Явно добавляем reply_markup если он есть
      if (options.reply_markup) {
        // КРИТИЧНО: Убеждаемся, что это объект, а не строка
        if (typeof options.reply_markup === 'string') {
          try {
            payload.reply_markup = JSON.parse(options.reply_markup);
          } catch (e) {
            logger.error('[TelegramDomainBot] Failed to parse reply_markup string:', e);
            payload.reply_markup = options.reply_markup;
          }
        } else {
          payload.reply_markup = options.reply_markup;
        }
      }

      // Добавляем остальные опции
      Object.keys(options).forEach(key => {
        if (key !== 'reply_markup') {
          payload[key] = options[key];
        }
      });

      // КРИТИЧНО: Проверяем reply_markup перед сериализацией
      if (payload.reply_markup) {
        if (typeof payload.reply_markup !== 'object' || payload.reply_markup === null) {
          logger.error('[TelegramDomainBot] reply_markup is not an object! Type:', typeof payload.reply_markup);
          return reject(new Error('reply_markup must be an object'));
        }
        // Убеждаемся, что это правильный объект с inline_keyboard
        if (!payload.reply_markup.inline_keyboard || !Array.isArray(payload.reply_markup.inline_keyboard)) {
          logger.error('[TelegramDomainBot] Invalid reply_markup structure:', payload.reply_markup);
          return reject(new Error('reply_markup must have inline_keyboard array'));
        }
      }
      
      const data = JSON.stringify(payload);

      const req = https.request({
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      }, (res) => {
        let responseData = '';
        res.on('data', (chunk) => { responseData += chunk; });
        res.on('end', () => {
          // Логируем статус код и заголовки
          logger.info(`[TelegramDomainBot] Response status: ${res.statusCode}, headers:`, res.headers);
          
          // Проверяем статус код
          if (res.statusCode !== 200) {
            logger.error(`[TelegramDomainBot] HTTP error ${res.statusCode}:`, responseData.substring(0, 500));
            reject(new Error(`HTTP ${res.statusCode}: ${responseData.substring(0, 200)}`));
            return;
          }
          
          try {
            // Проверяем, что ответ - это JSON
            if (!responseData.trim().startsWith('{')) {
              logger.error('[TelegramDomainBot] Response is not JSON:', responseData.substring(0, 500));
              reject(new Error(`Invalid response format: ${responseData.substring(0, 200)}`));
              return;
            }
            
            const result = JSON.parse(responseData);
            if (result.ok) {
              logger.info('[TelegramDomainBot] Message sent successfully.');
              logger.info('[TelegramDomainBot] Message ID:', result.result?.message_id);
              logger.info('[TelegramDomainBot] Chat ID:', result.result?.chat?.id);
              // Проверяем наличие reply_markup в ответе
              if (result.result?.reply_markup) {
                logger.info('[TelegramDomainBot] Reply markup in response:', JSON.stringify(result.result.reply_markup, null, 2));
              } else {
                logger.warn('[TelegramDomainBot] WARNING: No reply_markup in Telegram API response!');
                logger.warn('[TelegramDomainBot] Full result:', JSON.stringify(result.result, null, 2));
              }
              resolve(result);
            } else {
              logger.error('[TelegramDomainBot] Telegram API error:', result.description, 'Error code:', result.error_code, 'Full response:', responseData);
              reject(new Error(result.description || 'Unknown Telegram API error'));
            }
          } catch (error) {
            logger.error('[TelegramDomainBot] Error parsing response:', error.message);
            logger.error('[TelegramDomainBot] Response data (first 1000 chars):', responseData.substring(0, 1000));
            reject(new Error(`Parse error: ${error.message}`));
          }
        });
      });

      req.on('error', (error) => {
        logger.error('[TelegramDomainBot] Request error:', error);
        reject(error);
      });
      req.write(data);
      req.end();
    });
  }

  async editMessage(chatId, messageId, text, options = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        ...options
      });

      const req = https.request({
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${BOT_TOKEN}/editMessageText`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      }, (res) => {
        let responseData = '';
        res.on('data', (chunk) => { responseData += chunk; });
        res.on('end', () => {
          try {
            const result = JSON.parse(responseData);
            if (result.ok) {
              resolve(result);
            } else {
              reject(new Error(result.description));
            }
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  async answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: showAlert
      });

      const req = https.request({
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${BOT_TOKEN}/answerCallbackQuery`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      }, (res) => {
        let responseData = '';
        res.on('data', (chunk) => { responseData += chunk; });
        res.on('end', () => {
          try {
            const result = JSON.parse(responseData);
            resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  createMainKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: '🌐 Список доменов', callback_data: 'menu_domains' },
          { text: '🔄 Синхронизировать', callback_data: 'menu_sync' }
        ],
        [
          { text: 'ℹ️ Информация', callback_data: 'menu_info' }
        ]
      ]
    };
  }

  createDomainListKeyboard() {
    const availableDomains = domainManager.getAvailableDomains();
    const currentDomain = domainManager.getCurrentDomain();
    const allDomains = domainManager.getAllDomains();
    
    const keyboard = {
      inline_keyboard: []
    };

    // Текущий домен
    if (currentDomain) {
      const current = allDomains.find(d => d.domain === currentDomain);
      keyboard.inline_keyboard.push([{
        text: `✅ ${currentDomain} (активен)`,
        callback_data: `domain_info_${currentDomain}`
      }]);
    }

    // Доступные домены
    if (availableDomains.length > 0) {
      availableDomains.forEach(domain => {
        keyboard.inline_keyboard.push([{
          text: `🔄 ${domain.domain}`,
          callback_data: `domain_switch_${domain.domain}`
        }]);
      });
    } else {
      keyboard.inline_keyboard.push([{
        text: '⚠️ Нет доступных доменов',
        callback_data: 'domain_none'
      }]);
    }

    // Кнопки управления
    keyboard.inline_keyboard.push([
      {
        text: '🔄 Синхронизировать',
        callback_data: 'menu_sync'
      },
      {
        text: '◀️ Назад',
        callback_data: 'menu_main'
      }
    ]);

    return keyboard;
  }

  createDomainInfoKeyboard(domain) {
    const domainInfo = domainManager.getDomainInfo(domain);
    const currentDomain = domainManager.getCurrentDomain();
    
    const keyboard = {
      inline_keyboard: []
    };

    if (domain !== currentDomain && domainInfo && domainInfo.status === 'available') {
      keyboard.inline_keyboard.push([{
        text: `🔄 Переключить на ${domain}`,
        callback_data: `domain_switch_${domain}`
      }]);
    }

    keyboard.inline_keyboard.push([
      { text: '◀️ Назад к списку', callback_data: 'menu_domains' },
      { text: '🏠 Главное меню', callback_data: 'menu_main' }
    ]);

    return keyboard;
  }

  async showMainMenu(chatId) {
    try {
      logger.info(`[TelegramDomainBot] showMainMenu called for chat ${chatId}`);
      
      const currentDomain = domainManager.getCurrentDomain();
      const allDomains = domainManager.getAllDomains();
      const availableCount = domainManager.getAvailableDomains().length;
      
      let message = '🏠 <b>Главное меню</b>\n\n';
      
      if (currentDomain) {
        message += `✅ <b>Текущий домен:</b> <code>${currentDomain}</code>\n`;
      }
      
      message += `📊 <b>Всего доменов:</b> ${allDomains.length}\n`;
      message += `🔄 <b>Доступно для переключения:</b> ${availableCount}\n\n`;
      message += `Выберите действие:`;

      const keyboard = this.createMainKeyboard();
      // КРИТИЧНО: Убеждаемся, что keyboard - это объект
      logger.info(`[TelegramDomainBot] Created keyboard type:`, typeof keyboard);
      logger.info(`[TelegramDomainBot] Created keyboard:`, JSON.stringify(keyboard, null, 2));

      // КРИТИЧНО: Передаем объект напрямую, не через JSON.stringify
      await this.sendMessage(chatId, message, {
        reply_markup: keyboard
      });
      
      logger.info(`[TelegramDomainBot] showMainMenu completed for chat ${chatId}`);
    } catch (error) {
      logger.error(`[TelegramDomainBot] Error in showMainMenu:`, error);
      throw error;
    }
  }

  async showDomainList(chatId) {
    // Автоматически синхронизируем перед показом
    try {
      await domainManager.syncWithHoster();
    } catch (error) {
      logger.warn('[TelegramDomainBot] Sync failed, showing cached list:', error);
    }

    const currentDomain = domainManager.getCurrentDomain();
    const availableDomains = domainManager.getAvailableDomains();
    const allDomains = domainManager.getAllDomains();
    const lastSync = domainManager.domains.lastSync;

    let message = '🌐 <b>Список доменов</b>\n\n';
    
    if (currentDomain) {
      message += `✅ <b>Текущий домен:</b> <code>${currentDomain}</code>\n\n`;
    }
    
    message += `📋 <b>Доступно для переключения:</b> ${availableDomains.length}\n`;
    message += `📊 <b>Всего доменов:</b> ${allDomains.length}\n`;
    
    if (lastSync) {
      const syncDate = new Date(lastSync);
      message += `🕐 <b>Последняя синхронизация:</b> ${syncDate.toLocaleString('ru-RU')}\n`;
    }

    if (availableDomains.length > 0) {
      message += '\n<b>Доступные домены:</b>\n';
      availableDomains.forEach(domain => {
        message += `  • <code>${domain.domain}</code>\n`;
      });
    } else {
      message += '\n⚠️ <i>Нет доступных доменов. Используйте синхронизацию.</i>';
    }

    message += '\n\n<b>Нажмите на домен для просмотра информации или переключения.</b>';

    await this.sendMessage(chatId, message, {
      reply_markup: this.createDomainListKeyboard()
    });
  }

  async showDomainInfo(chatId, domain) {
    const domainInfo = domainManager.getDomainInfo(domain);
    const currentDomain = domainManager.getCurrentDomain();
    
    if (!domainInfo) {
      await this.sendMessage(chatId, `❌ Домен <code>${domain}</code> не найден.`);
      return;
    }

    let message = `ℹ️ <b>Информация о домене</b>\n\n`;
    message += `🌐 <b>Домен:</b> <code>${domain}</code>\n`;
    message += `📊 <b>Статус:</b> `;
    
    if (domain === currentDomain) {
      message += `✅ <b>Активен</b>\n`;
    } else if (domainInfo.status === 'available') {
      message += `🔄 Доступен\n`;
    } else if (domainInfo.status === 'unavailable') {
      message += `⚠️ Недоступен\n`;
    } else {
      message += `${domainInfo.status}\n`;
    }

    if (domainInfo.hosterZoneId) {
      message += `🆔 <b>Zone ID:</b> <code>${domainInfo.hosterZoneId}</code>\n`;
    }

    if (domainInfo.dnsRecordId) {
      message += `📝 <b>DNS Record ID:</b> <code>${domainInfo.dnsRecordId}</code>\n`;
    }

    if (domainInfo.lastSwitched) {
      const switchDate = new Date(domainInfo.lastSwitched);
      message += `🕐 <b>Последнее переключение:</b> ${switchDate.toLocaleString('ru-RU')}\n`;
    }

    if (domainInfo.createdAt) {
      const createDate = new Date(domainInfo.createdAt);
      message += `📅 <b>Добавлен:</b> ${createDate.toLocaleString('ru-RU')}\n`;
    }

    if (domain === currentDomain) {
      message += `\n📍 <b>IP адрес:</b> <code>${domainManager.serverIP}</code>\n`;
    }

    await this.sendMessage(chatId, message, {
      reply_markup: this.createDomainInfoKeyboard(domain)
    });
  }

  async syncDomains(chatId) {
    try {
      await this.sendMessage(chatId, '🔄 Синхронизация с хостером...');
      
      const result = await domainManager.syncWithHoster(true);
      
      await this.sendMessage(chatId, 
        `✅ <b>Синхронизация завершена!</b>\n\n` +
        `📊 Всего доменов: ${result.total}\n` +
        `🔄 Синхронизировано: ${result.synced}\n` +
        `➕ Добавлено новых: ${result.added}\n\n` +
        `🕐 Время: ${new Date().toLocaleString('ru-RU')}`
      );
      
      // Показать обновленный список
      await this.showDomainList(chatId);
    } catch (error) {
      logger.error('[TelegramDomainBot] Error syncing domains:', error);
      await this.sendMessage(chatId, 
        `❌ <b>Ошибка синхронизации:</b>\n\n` +
        `<code>${error.message}</code>\n\n` +
        `Проверьте:\n` +
        `• HOSTER_API_TOKEN в .env\n` +
        `• Права доступа токена\n` +
        `• Подключение к интернету`
      );
    }
  }

  async switchDomain(chatId, domain, messageId = null) {
    try {
      const loadingText = `🔄 Переключаю домен на <code>${domain}</code>...\n\nЭто может занять несколько минут.`;
      
      let loadingMsg;
      if (messageId) {
        await this.editMessage(chatId, messageId, loadingText);
      } else {
        loadingMsg = await this.sendMessage(chatId, loadingText);
        messageId = loadingMsg.result.message_id;
      }
      
      const result = await domainManager.switchDomain(domain);
      
      let successMessage = `✅ <b>Домен успешно переключен!</b>\n\n`;
      successMessage += `🌐 <b>Новый домен:</b> <code>${result.domain}</code>\n`;
      successMessage += `📍 <b>IP адрес:</b> <code>${result.ip}</code>\n`;
      
      if (result.sslObtained) {
        successMessage += `🔒 <b>SSL сертификат:</b> Получен\n`;
      } else {
        successMessage += `⚠️ <b>SSL сертификат:</b> Не получен (проверьте вручную)\n`;
      }
      
      successMessage += `🆔 <b>DNS Record ID:</b> <code>${result.dnsRecordId}</code>\n`;
      successMessage += `⏰ <b>Время:</b> ${new Date().toLocaleString('ru-RU')}\n\n`;
      successMessage += `🔄 Сервер перезапущен автоматически.\n`;
      successMessage += `⏳ DNS изменения могут занять до 5 минут.`;
      
      await this.editMessage(chatId, messageId, successMessage, {
        reply_markup: this.createDomainInfoKeyboard(domain)
      });
      
      // Обновить список доменов
      await this.showDomainList(chatId);
    } catch (error) {
      logger.error('[TelegramDomainBot] Error switching domain:', error);
      const errorMessage = `❌ <b>Ошибка при переключении домена:</b>\n\n<code>${error.message}</code>\n\nПопробуйте:\n• Синхронизировать домены\n• Проверить настройки в .env`;
      
      if (messageId) {
        await this.editMessage(chatId, messageId, errorMessage);
      } else {
        await this.sendMessage(chatId, errorMessage);
      }
    }
  }

  async showInfo(chatId) {
    const currentDomain = domainManager.getCurrentDomain();
    const allDomains = domainManager.getAllDomains();
    const availableDomains = domainManager.getAvailableDomains();
    const lastSync = domainManager.domains.lastSync;
    
    let message = 'ℹ️ <b>Информация о системе</b>\n\n';
    message += `🌐 <b>Текущий домен:</b> ${currentDomain ? `<code>${currentDomain}</code>` : 'Не установлен'}\n`;
    message += `📍 <b>IP сервера:</b> <code>${domainManager.serverIP}</code>\n`;
    message += `📊 <b>Всего доменов:</b> ${allDomains.length}\n`;
    message += `🔄 <b>Доступно:</b> ${availableDomains.length}\n`;
    
    if (lastSync) {
      const syncDate = new Date(lastSync);
      message += `🕐 <b>Последняя синхронизация:</b> ${syncDate.toLocaleString('ru-RU')}\n`;
    }
    
    message += `\n<b>Используйте кнопки для управления доменами.</b>`;

    await this.sendMessage(chatId, message, {
      reply_markup: this.createMainKeyboard()
    });
  }

  async handleCommand(chatId, command, args) {
    try {
      logger.info(`[TelegramDomainBot] handleCommand: ${command} for chat ${chatId}`);
      
      switch (command) {
        case '/start':
        case '/menu':
          logger.info(`[TelegramDomainBot] Calling showMainMenu for chat ${chatId}`);
          await this.showMainMenu(chatId);
          break;
        case '/domains':
          await this.showDomainList(chatId);
          break;
        case '/sync':
          await this.syncDomains(chatId);
          break;
        case '/info':
          await this.showInfo(chatId);
          break;
        default:
          await this.showMainMenu(chatId);
      }
      
      logger.info(`[TelegramDomainBot] handleCommand completed: ${command}`);
    } catch (error) {
      logger.error('[TelegramDomainBot] Error handling command:', error);
      logger.error('[TelegramDomainBot] Error stack:', error.stack);
      try {
        await this.sendMessage(chatId, `❌ Ошибка: ${error.message}`);
      } catch (sendError) {
        logger.error('[TelegramDomainBot] Failed to send error message:', sendError);
      }
    }
  }

  async handleCallbackQuery(callbackQuery) {
    const { id, data, message, from } = callbackQuery;
    const chatId = message.chat.id;
    const messageId = message.message_id;

    try {
      // Отвечаем на callback сразу
      await this.answerCallbackQuery(id, '', false);

      if (data === 'menu_main') {
        await this.editMessage(chatId, messageId, '🏠 <b>Главное меню</b>\n\nВыберите действие:', {
          reply_markup: this.createMainKeyboard()
        });
      } else if (data === 'menu_domains') {
        await this.showDomainList(chatId);
      } else if (data === 'menu_sync') {
        await this.syncDomains(chatId);
      } else if (data === 'menu_info') {
        await this.showInfo(chatId);
      } else if (data.startsWith('domain_info_')) {
        const domain = data.replace('domain_info_', '');
        await this.showDomainInfo(chatId, domain);
      } else if (data.startsWith('domain_switch_')) {
        const domain = data.replace('domain_switch_', '');
        await this.switchDomain(chatId, domain, messageId);
      } else if (data === 'domain_none') {
        await this.answerCallbackQuery(id, 'Нет доступных доменов. Используйте синхронизацию.', true);
      }
    } catch (error) {
      logger.error('[TelegramDomainBot] Error handling callback:', error);
      await this.answerCallbackQuery(id, `Ошибка: ${error.message}`, true);
    }
  }

  setupWebhook() {
    logger.info('[TelegramDomainBot] Bot initialized');
  }
}

module.exports = new TelegramDomainBot();
