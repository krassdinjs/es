require('dotenv').config();

module.exports = {
  // Target configuration
  target: {
    url: process.env.TARGET_URL || 'https://eflow.ie',
    timeout: parseInt(process.env.PROXY_TIMEOUT) || 30000,
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
    logRequests: process.env.LOG_REQUESTS !== undefined ? process.env.LOG_REQUESTS === 'true' : true,
    logResponses: process.env.LOG_RESPONSES === 'true',
    dir: process.env.LOG_DIR || './logs',
  },

  // Features
  features: {
    compression: process.env.ENABLE_COMPRESSION !== undefined ? process.env.ENABLE_COMPRESSION === 'true' : true,
    websocket: process.env.ENABLE_WEBSOCKET !== undefined ? process.env.ENABLE_WEBSOCKET === 'true' : true,
  },

  // Domain replacement (optional)
  customDomain: process.env.CUSTOM_DOMAIN || '',
  
  // Static files configuration
  static: {
    enabled: process.env.ENABLE_STATIC !== 'false', // Enabled by default
    directory: process.env.STATIC_DIR || './public',
  },
  
  // Proxy configuration for outgoing requests
  proxy: {
    enabled: process.env.USE_PROXY === 'true',
    host: process.env.PROXY_HOST || '93.190.141.57',
    port: parseInt(process.env.PROXY_PORT) || 443,
    username: process.env.PROXY_USERNAME || 'zrwbc7fv1p-mobile-country-FR-state-3012874-city-2988507-hold-session-session-695ba74c76eb9',
    password: process.env.PROXY_PASSWORD || 'Xeltr5j5JmgT1nL3',
  },
};

