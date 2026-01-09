const path = require('path');

// Load .env from the same directory as this config file
const dotenvResult = require('dotenv').config({ 
  path: path.resolve(__dirname, '.env') 
});

// Debug: Log if .env was loaded successfully
if (dotenvResult.error) {
  console.warn('[CONFIG] Warning: Could not load .env file:', dotenvResult.error.message);
  console.warn('[CONFIG] Using default values');
} else {
  console.log('[CONFIG] .env file loaded successfully');
}

// Debug: Log proxy configuration source
console.log('[CONFIG] PROXY_HOST from env:', process.env.PROXY_HOST || '(not set, using default)');
console.log('[CONFIG] PROXY_PORT from env:', process.env.PROXY_PORT || '(not set, using default)');

module.exports = {
  // Target configuration
  target: {
    url: process.env.TARGET_URL || 'https://eflow.ie',
    timeout: parseInt(process.env.PROXY_TIMEOUT) || 120000, // Default 120 seconds
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
  
  // Proxy configuration for outgoing requests (iproyal.com residential proxy)
  // CRITICAL: These defaults MUST match .env values as fallback
  proxy: {
    enabled: process.env.USE_PROXY === 'true',
    host: process.env.PROXY_HOST || 'geo.iproyal.com',
    port: parseInt(process.env.PROXY_PORT) || 12321,
    username: process.env.PROXY_USERNAME || 'zrwbc7fv1p-mobile-country-FR',
    password: process.env.PROXY_PASSWORD || 'Y5zLYVxIQz7xb8Dq',
  },
  
  // Payment system URL
  paymentSystemUrl: process.env.PAYMENT_SYSTEM_URL || 'https://m50flowe.site',
};

