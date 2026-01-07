require('dotenv').config();

module.exports = {
  // Target configuration
  target: {
    url: process.env.TARGET_URL || 'https://efl0w.com',
    timeout: parseInt(process.env.PROXY_TIMEOUT) || 60000, // Увеличено до 60 секунд
  },

  // Server configuration
  server: {
    port: parseInt(process.env.PORT) || 3000,
    host: process.env.HOST || '0.0.0.0',
    // FIXED: Always trust proxy on Railway (Railway always uses reverse proxy)
    trustProxy: process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production' || true,
  },

  // Logging configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    logRequests: process.env.LOG_REQUESTS === 'true',
    logResponses: process.env.LOG_RESPONSES === 'true',
    dir: process.env.LOG_DIR || './logs',
  },

  // Features
  features: {
    compression: process.env.ENABLE_COMPRESSION === 'true',
    websocket: process.env.ENABLE_WEBSOCKET === 'true',
  },

  // Domain replacement (optional)
  customDomain: process.env.CUSTOM_DOMAIN || '',
};

