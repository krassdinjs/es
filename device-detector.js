/**
 * Device Detector - определение типа устройства и характеристик пользователя
 * Использует User-Agent парсинг и внешние API для достоверной информации
 */

const useragent = require('useragent');
const https = require('https');
const logger = require('./logger');

// Кэш для результатов определения устройства (чтобы не спамить API)
const deviceCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 часа

/**
 * Определить тип устройства из User-Agent
 */
function detectDeviceType(userAgent) {
  if (!userAgent || userAgent.trim() === '') {
    return { deviceType: 'unknown', browser: 'Unknown', os: 'Unknown' };
  }
  
  try {
    const agent = useragent.parse(userAgent);
    
    // Определить тип устройства
    let deviceType = 'desktop';
    
    // Проверка на мобильные устройства
    if (userAgent.match(/Mobile|Android|iPhone|iPad|iPod|BlackBerry|Windows Phone/i)) {
      if (userAgent.match(/iPad/i)) {
        deviceType = 'tablet';
      } else if (userAgent.match(/iPhone|iPod|Android.*Mobile|BlackBerry|Windows Phone/i)) {
        deviceType = 'phone';
      } else {
        deviceType = 'phone'; // По умолчанию мобильное = телефон
      }
    }
    
    // Проверка на планшеты
    if (userAgent.match(/Tablet|iPad|Android(?!.*Mobile)/i)) {
      deviceType = 'tablet';
    }
    
    return {
      deviceType,
      browser: agent.family || 'Unknown',
      os: agent.os.family || 'Unknown',
      browserVersion: agent.major || '',
      osVersion: agent.os.major || '',
      userAgent: userAgent
    };
  } catch (error) {
    logger.error('[DeviceDetector] Parse error:', error.message);
    return { deviceType: 'unknown', browser: 'Unknown', os: 'Unknown' };
  }
}

/**
 * Получить информацию об IP через внешний API (ip-api.com - бесплатный)
 */
async function getIPInfo(ip) {
  // Пропустить локальные IP
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
    return { country: 'Local', city: 'Local' };
  }
  
  // Проверить кэш
  const cacheKey = `ip_${ip}`;
  const cached = deviceCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }
  
  try {
    return new Promise((resolve, reject) => {
      const url = `https://ip-api.com/json/${ip}?fields=status,message,country,countryCode,city,region,regionName,lat,lon,timezone,isp,org,as,query`;
      
      const req = https.get(url, { timeout: 5000 }, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            
            if (result.status === 'success') {
              const ipInfo = {
                country: result.country || 'Unknown',
                city: result.city || 'Unknown',
                region: result.regionName || '',
                timezone: result.timezone || '',
                isp: result.isp || '',
                lat: result.lat,
                lon: result.lon
              };
              
              // Сохранить в кэш
              deviceCache.set(cacheKey, {
                data: ipInfo,
                timestamp: Date.now()
              });
              
              resolve(ipInfo);
            } else {
              logger.warn(`[DeviceDetector] IP API error: ${result.message}`);
              resolve({ country: 'Unknown', city: 'Unknown' });
            }
          } catch (error) {
            logger.error('[DeviceDetector] IP API parse error:', error.message);
            resolve({ country: 'Unknown', city: 'Unknown' });
          }
        });
      });
      
      req.on('error', (error) => {
        logger.error('[DeviceDetector] IP API request error:', error.message);
        resolve({ country: 'Unknown', city: 'Unknown' });
      });
      
      req.on('timeout', () => {
        req.destroy();
        logger.warn('[DeviceDetector] IP API request timeout');
        resolve({ country: 'Unknown', city: 'Unknown' });
      });
      
      // Установить таймаут на запрос
      req.setTimeout(5000);
    });
  } catch (error) {
    logger.error('[DeviceDetector] IP info error:', error.message);
    return { country: 'Unknown', city: 'Unknown' };
  }
}

/**
 * Получить полную информацию об устройстве и пользователе
 */
async function getFullDeviceInfo(ip, userAgent) {
  // Парсинг User-Agent
  const deviceInfo = detectDeviceType(userAgent);
  
  // Информация об IP (асинхронно, не блокируем)
  let ipInfo = { country: 'Unknown', city: 'Unknown' };
  try {
    ipInfo = await getIPInfo(ip);
  } catch (error) {
    logger.error('[DeviceDetector] Failed to get IP info:', error.message);
  }
  
  return {
    ...deviceInfo,
    ...ipInfo,
    ip: ip
  };
}

/**
 * Очистить старый кэш
 */
function clearOldCache() {
  const now = Date.now();
  for (const [key, value] of deviceCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      deviceCache.delete(key);
    }
  }
}

// Очищать кэш каждые 6 часов
setInterval(clearOldCache, 6 * 60 * 60 * 1000);

module.exports = {
  detectDeviceType,
  getIPInfo,
  getFullDeviceInfo,
  clearOldCache
};
