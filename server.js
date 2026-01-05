const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
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

// Middleware: Compression
if (config.features.compression) {
  app.use(compression());
}

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
  
  // Handle response
  onProxyRes: (proxyRes, req, res) => {
    // Log proxy response
    logger.debug(`Received response ${proxyRes.statusCode} for ${req.url}`);
    
    // === CACHING LOGIC ===
    // Cache successful GET responses
    if (cacheManager.shouldCache(req, { statusCode: proxyRes.statusCode })) {
      let body = [];
      
      proxyRes.on('data', (chunk) => {
        body.push(chunk);
      });
      
      proxyRes.on('end', () => {
        const fullBody = Buffer.concat(body);
        const contentType = proxyRes.headers['content-type'];
        
        // Store in cache
        cacheManager.set(req, {
          body: fullBody,
          contentType: contentType,
          statusCode: proxyRes.statusCode,
        });
        
        logger.debug(`Cached response for ${req.url}`);
      });
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
      
      proxyRes.headers['set-cookie'] = cookies;
    }
    
    // Handle CORS headers
    const allowedHeaders = [
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-allow-methods',
      'access-control-allow-headers',
    ];
    
    allowedHeaders.forEach((header) => {
      if (proxyRes.headers[header]) {
        res.setHeader(header, proxyRes.headers[header]);
      }
    });
    
    // Enable credentials
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Handle content rewriting for custom domain
    if (config.customDomain) {
      const contentType = proxyRes.headers['content-type'] || '';
      
      if (
        contentType.includes('text/html') ||
        contentType.includes('application/javascript') ||
        contentType.includes('text/css')
      ) {
        let body = [];
        
        proxyRes.on('data', (chunk) => {
          body.push(chunk);
        });
        
        proxyRes.on('end', () => {
          body = Buffer.concat(body).toString();
          
          // Replace target domain with custom domain
          const targetDomain = new URL(config.target.url).hostname;
          body = body.replace(
            new RegExp(targetDomain, 'g'),
            config.customDomain
          );
          
          res.send(body);
        });
        
        // Prevent automatic pipe
        delete proxyRes.headers['content-length'];
      }
    }
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

