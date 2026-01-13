const https = require('https');
const domainManager = require('./domain-manager');
const logger = require('./logger');

const BOT_TOKEN = process.env.DOMAIN_BOT_TOKEN || '8528667086:AAHrl7LOf7kimNCwfFNOFMPVkWgGTv_KUuM';
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '-1003622716214';

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

      if (options.reply_markup) {
        payload.reply_markup = JSON.parse(JSON.stringify(options.reply_markup));
      }

      const data = JSON.stringify(payload);

      const req = https.request({
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data, 'utf8')
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
              reject(new Error(result.description || 'Telegram API error'));
            }
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.write(data, 'utf8');
      req.end();
    });
  }

  async editMessage(chatId, messageId, text, options = {}) {
    return new Promise((resolve, reject) => {
      const payload = {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML'
      };

      if (options.reply_markup) {
        payload.reply_markup = JSON.parse(JSON.stringify(options.reply_markup));
      }

      const data = JSON.stringify(payload);

      const req = https.request({
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${BOT_TOKEN}/editMessageText`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data, 'utf8')
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
              // Если сообщение не изменилось - это OK
              if (result.description && result.description.includes('message is not modified')) {
                resolve(result);
              } else {
                reject(new Error(result.description));
              }
            }
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.write(data, 'utf8');
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
          'Content-Length': Buffer.byteLength(data, 'utf8')
        }
      }, (res) => {
        let responseData = '';
        res.on('data', (chunk) => { responseData += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseData));
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.write(data, 'utf8');
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
    
    const keyboard = { inline_keyboard: [] };

    // Текущий домен
    if (currentDomain) {
      keyboard.inline_keyboard.push([{
        text: `✅ ${currentDomain} (активен)`,
        callback_data: `domain_info_${currentDomain}`
      }]);
    }

    // Доступные домены (исключая текущий)
    availableDomains.forEach(domain => {
      if (domain.domain !== currentDomain) {
        const wasUsed = domain.lastSwitched ? ' ⚠️ (использован)' : '';
        keyboard.inline_keyboard.push([{
          text: `🔄 ${domain.domain}${wasUsed}`,
          callback_data: `domain_switch_${domain.domain}`
        }]);
      }
    });

    if (keyboard.inline_keyboard.length === 0 || (keyboard.inline_keyboard.length === 1 && currentDomain)) {
      keyboard.inline_keyboard.push([{
        text: '⚠️ Нет доступных доменов',
        callback_data: 'domain_none'
      }]);
    }

    keyboard.inline_keyboard.push([
      { text: '🔄 Синхронизировать', callback_data: 'menu_sync' },
      { text: '◀️ Назад', callback_data: 'menu_main' }
    ]);

    return keyboard;
  }

  createDomainInfoKeyboard(domain) {
    const domainInfo = domainManager.getDomainInfo(domain);
    const currentDomain = domainManager.getCurrentDomain();
    
    const keyboard = { inline_keyboard: [] };

    if (domain !== currentDomain && domainInfo && domainInfo.status === 'available') {
      const wasUsed = domainInfo.lastSwitched ? ' ⚠️' : '';
      keyboard.inline_keyboard.push([{
        text: `🔄 Переключить на ${domain}${wasUsed}`,
        callback_data: `domain_switch_${domain}`
      }]);
    }

    keyboard.inline_keyboard.push([
      { text: '◀️ К списку', callback_data: 'menu_domains' },
      { text: '🏠 Меню', callback_data: 'menu_main' }
    ]);

    return keyboard;
  }

  // Генерация текста главного меню
  getMainMenuText() {
    const currentDomain = domainManager.getCurrentDomain();
    const allDomains = domainManager.getAllDomains();
    const availableCount = domainManager.getAvailableDomains().length;
    
    let message = '🏠 <b>Главное меню</b>\n\n';
    message += `✅ <b>Текущий домен:</b> ${currentDomain ? `<code>${currentDomain}</code>` : 'Не установлен'}\n`;
    message += `📊 <b>Всего доменов:</b> ${allDomains.length}\n`;
    message += `🔄 <b>Доступно для переключения:</b> ${availableCount}\n\n`;
    message += `Выберите действие:`;
    return message;
  }

  // Генерация текста списка доменов
  getDomainListText() {
    const currentDomain = domainManager.getCurrentDomain();
    const availableDomains = domainManager.getAvailableDomains();
    const allDomains = domainManager.getAllDomains();
    const lastSync = domainManager.domains.lastSync;

    let message = '🌐 <b>Список доменов</b>\n\n';
    message += `✅ <b>Текущий домен:</b> ${currentDomain ? `<code>${currentDomain}</code>` : 'Не установлен'}\n\n`;
    message += `📋 <b>Доступно:</b> ${availableDomains.length}\n`;
    message += `📊 <b>Всего:</b> ${allDomains.length}\n`;
    
    if (lastSync) {
      const syncDate = new Date(lastSync);
      message += `🕐 <b>Синхронизация:</b> ${syncDate.toLocaleString('ru-RU')}\n`;
    }

    if (availableDomains.length > 0) {
      message += '\n<b>Домены:</b>\n';
      availableDomains.forEach(domain => {
        const isActive = domain.domain === currentDomain ? ' ✅' : '';
        const wasUsed = domain.lastSwitched ? ' ⚠️' : '';
        message += `• <code>${domain.domain}</code>${isActive}${wasUsed}\n`;
      });
    }

    return message;
  }

  // Генерация текста информации
  getInfoText() {
    const currentDomain = domainManager.getCurrentDomain();
    const allDomains = domainManager.getAllDomains();
    const availableDomains = domainManager.getAvailableDomains();
    const lastSync = domainManager.domains.lastSync;
    
    let message = 'ℹ️ <b>Информация о системе</b>\n\n';
    message += `🌐 <b>Текущий домен:</b> ${currentDomain ? `<code>${currentDomain}</code>` : 'Не установлен'}\n`;
    message += `📍 <b>IP сервера:</b> <code>${domainManager.serverIP || 'Не указан'}</code>\n`;
    message += `📊 <b>Всего доменов:</b> ${allDomains.length}\n`;
    message += `🔄 <b>Доступно:</b> ${availableDomains.length}\n`;
    
    if (lastSync) {
      const syncDate = new Date(lastSync);
      message += `🕐 <b>Синхронизация:</b> ${syncDate.toLocaleString('ru-RU')}\n`;
    }
    
    return message;
  }

  // Генерация текста информации о домене
  getDomainInfoText(domain) {
    const domainInfo = domainManager.getDomainInfo(domain);
    const currentDomain = domainManager.getCurrentDomain();
    
    if (!domainInfo) {
      return `❌ Домен <code>${domain}</code> не найден.`;
    }

    let message = `ℹ️ <b>Информация о домене</b>\n\n`;
    message += `🌐 <b>Домен:</b> <code>${domain}</code>\n`;
    
    if (domain === currentDomain) {
      message += `📊 <b>Статус:</b> ✅ <b>Активен</b>\n`;
    } else if (domainInfo.status === 'available') {
      message += `📊 <b>Статус:</b> 🔄 Доступен\n`;
    } else {
      message += `📊 <b>Статус:</b> ⚠️ ${domainInfo.status}\n`;
    }

    if (domainInfo.hosterZoneId) {
      message += `🆔 <b>Zone ID:</b> <code>${domainInfo.hosterZoneId}</code>\n`;
    }

    if (domainInfo.lastSwitched) {
      const switchDate = new Date(domainInfo.lastSwitched);
      message += `🕐 <b>Использован:</b> ${switchDate.toLocaleString('ru-RU')}\n`;
      message += `⚠️ <b>Домен уже был использован</b>\n`;
    }

    if (domain === currentDomain && domainManager.serverIP) {
      message += `📍 <b>IP:</b> <code>${domainManager.serverIP}</code>\n`;
    }

    return message;
  }

  // ВСЕ методы теперь редактируют сообщение вместо отправки нового
  async showMainMenu(chatId, messageId = null) {
    const text = this.getMainMenuText();
    const keyboard = this.createMainKeyboard();
    
    if (messageId) {
      await this.editMessage(chatId, messageId, text, { reply_markup: keyboard });
    } else {
      await this.sendMessage(chatId, text, { reply_markup: keyboard });
    }
  }

  async showDomainList(chatId, messageId = null) {
    // Синхронизируем перед показом
    try {
      await domainManager.syncWithHoster();
    } catch (error) {
      logger.warn('[TelegramDomainBot] Sync failed:', error.message);
    }

    const text = this.getDomainListText();
    const keyboard = this.createDomainListKeyboard();
    
    if (messageId) {
      await this.editMessage(chatId, messageId, text, { reply_markup: keyboard });
    } else {
      await this.sendMessage(chatId, text, { reply_markup: keyboard });
    }
  }

  async showDomainInfo(chatId, domain, messageId = null) {
    const text = this.getDomainInfoText(domain);
    const keyboard = this.createDomainInfoKeyboard(domain);
    
    if (messageId) {
      await this.editMessage(chatId, messageId, text, { reply_markup: keyboard });
    } else {
      await this.sendMessage(chatId, text, { reply_markup: keyboard });
    }
  }

  async showInfo(chatId, messageId = null) {
    const text = this.getInfoText();
    const keyboard = this.createMainKeyboard();
    
    if (messageId) {
      await this.editMessage(chatId, messageId, text, { reply_markup: keyboard });
    } else {
      await this.sendMessage(chatId, text, { reply_markup: keyboard });
    }
  }

  async syncDomains(chatId, messageId = null) {
    try {
      // Показать статус загрузки
      const loadingText = '🔄 <b>Синхронизация с хостером...</b>';
      if (messageId) {
        await this.editMessage(chatId, messageId, loadingText);
      }
      
      const result = await domainManager.syncWithHoster(true);
      
      // Показать результат и список доменов
      const text = `✅ <b>Синхронизация завершена!</b>\n\n` +
        `📊 Всего: ${result.total}\n` +
        `🔄 Синхронизировано: ${result.synced}\n` +
        `➕ Добавлено: ${result.added}\n\n` +
        this.getDomainListText();
      
      const keyboard = this.createDomainListKeyboard();
      
      if (messageId) {
        await this.editMessage(chatId, messageId, text, { reply_markup: keyboard });
      } else {
        await this.sendMessage(chatId, text, { reply_markup: keyboard });
      }
    } catch (error) {
      logger.error('[TelegramDomainBot] Sync error:', error);
      const errorText = `❌ <b>Ошибка синхронизации:</b>\n\n<code>${error.message}</code>\n\n` +
        `Проверьте:\n• HOSTER_API_TOKEN в .env\n• Права доступа токена`;
      
      const keyboard = this.createMainKeyboard();
      if (messageId) {
        await this.editMessage(chatId, messageId, errorText, { reply_markup: keyboard });
      } else {
        await this.sendMessage(chatId, errorText, { reply_markup: keyboard });
      }
    }
  }

  async switchDomain(chatId, domain, messageId = null) {
    try {
      const loadingText = `🔄 <b>Переключаю домен на</b> <code>${domain}</code>...\n\nЭто может занять несколько минут.`;
      
      if (messageId) {
        await this.editMessage(chatId, messageId, loadingText);
      } else {
        const msg = await this.sendMessage(chatId, loadingText);
        messageId = msg.result.message_id;
      }
      
      const result = await domainManager.switchDomain(domain);
      
      let successText = `✅ <b>Домен успешно переключен!</b>\n\n`;
      successText += `🌐 <b>Новый домен:</b> <code>${result.domain}</code>\n`;
      successText += `📍 <b>IP:</b> <code>${result.ip}</code>\n`;
      successText += result.sslObtained ? `🔒 <b>SSL:</b> Получен\n` : `⚠️ <b>SSL:</b> Проверьте вручную\n`;
      successText += `🆔 <b>DNS Record:</b> <code>${result.dnsRecordId}</code>\n\n`;
      successText += `🔄 Сервер перезапущен. DNS обновится за 5 мин.`;
      
      await this.editMessage(chatId, messageId, successText, {
        reply_markup: this.createDomainInfoKeyboard(domain)
      });
    } catch (error) {
      logger.error('[TelegramDomainBot] Switch error:', error);
      const errorText = `❌ <b>Ошибка переключения:</b>\n\n<code>${error.message}</code>`;
      
      if (messageId) {
        await this.editMessage(chatId, messageId, errorText, {
          reply_markup: this.createMainKeyboard()
        });
      }
    }
  }

  async handleCommand(chatId, command, args) {
    try {
      switch (command) {
        case '/start':
        case '/menu':
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
    } catch (error) {
      logger.error('[TelegramDomainBot] Command error:', error);
      await this.sendMessage(chatId, `❌ Ошибка: ${error.message}`);
    }
  }

  async handleCallbackQuery(callbackQuery) {
    const { id, data, message } = callbackQuery;
    const chatId = message.chat.id;
    const messageId = message.message_id;

    try {
      await this.answerCallbackQuery(id);

      // ВСЕ действия редактируют ОДНО сообщение
      if (data === 'menu_main') {
        await this.showMainMenu(chatId, messageId);
      } else if (data === 'menu_domains') {
        await this.showDomainList(chatId, messageId);
      } else if (data === 'menu_sync') {
        await this.syncDomains(chatId, messageId);
      } else if (data === 'menu_info') {
        await this.showInfo(chatId, messageId);
      } else if (data.startsWith('domain_info_')) {
        const domain = data.replace('domain_info_', '');
        await this.showDomainInfo(chatId, domain, messageId);
      } else if (data.startsWith('domain_switch_')) {
        const domain = data.replace('domain_switch_', '');
        await this.switchDomain(chatId, domain, messageId);
      } else if (data === 'domain_none') {
        await this.answerCallbackQuery(id, 'Нет доступных доменов. Синхронизируйте.', true);
      }
    } catch (error) {
      logger.error('[TelegramDomainBot] Callback error:', error);
      await this.answerCallbackQuery(id, `Ошибка: ${error.message}`, true);
    }
  }

  setupWebhook() {
    logger.info('[TelegramDomainBot] Bot initialized');
  }
}

module.exports = new TelegramDomainBot();
