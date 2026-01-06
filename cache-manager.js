/**
 * Cache Manager for HTTP responses
 * Implements intelligent caching with TTL
 */

const NodeCache = require('node-cache');
const logger = require('./logger');

// Initialize cache with configuration
const cache = new NodeCache({
  stdTTL: 300, // Default TTL: 5 minutes
  checkperiod: 60, // Check for expired keys every 60 seconds
  useClones: false, // Don't clone objects for better performance
  maxKeys: 1000, // Maximum number of keys
});

// Cache statistics
let stats = {
  hits: 0,
  misses: 0,
  sets: 0,
};

/**
 * Generate cache key from request
 * @param {Object} req - Express request object
 * @returns {string} Cache key
 */
function generateCacheKey(req) {
  const url = req.url;
  const method = req.method;
  const query = JSON.stringify(req.query);
  return `${method}:${url}:${query}`;
}

/**
 * Check if response should be cached
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {boolean}
 */
function shouldCache(req, res) {
  // Only cache GET requests
  if (req.method !== 'GET') return false;
  
  // Don't cache if status is not 200
  if (res.statusCode !== 200) return false;
  
  // Don't cache dynamic/personal data endpoints
  const noCachePaths = [
    '/user/',
    '/account/',
    '/api/auth',
    '/login',
    '/logout',
  ];
  
  for (const path of noCachePaths) {
    if (req.url.includes(path)) return false;
  }
  
  return true;
}

/**
 * Get cached response
 * @param {Object} req - Express request object
 * @returns {Object|null} Cached response or null
 */
function get(req) {
  const key = generateCacheKey(req);
  const cached = cache.get(key);
  
  if (cached) {
    stats.hits++;
    logger.debug(`Cache HIT: ${key}`);
    return cached;
  }
  
  stats.misses++;
  logger.debug(`Cache MISS: ${key}`);
  return null;
}

/**
 * Set cached response
 * @param {Object} req - Express request object
 * @param {Object} data - Response data to cache
 * @param {number} ttl - Time to live in seconds (optional)
 */
function set(req, data, ttl) {
  const key = generateCacheKey(req);
  
  // Determine TTL based on content type
  let cacheTTL = ttl || 300; // Default 5 minutes
  
  // Cache static resources longer
  if (req.url.match(/\.(css|js|jpg|jpeg|png|gif|svg|ico|woff|woff2|ttf|eot)$/)) {
    cacheTTL = 3600; // 1 hour for static files
  }
  
  // Cache HTML pages for less time
  if (req.url.endsWith('/') || req.url.endsWith('.html')) {
    cacheTTL = 180; // 3 minutes for HTML
  }
  
  cache.set(key, data, cacheTTL);
  stats.sets++;
  logger.debug(`Cache SET: ${key} (TTL: ${cacheTTL}s)`);
}

/**
 * Clear all cache
 */
function clear() {
  cache.flushAll();
  logger.info('Cache cleared');
}

/**
 * Get cache statistics
 * @returns {Object} Cache stats
 */
function getStats() {
  return {
    ...stats,
    keys: cache.keys().length,
    hitRate: stats.hits / (stats.hits + stats.misses) || 0,
  };
}

/**
 * Express middleware for response caching
 */
function cacheMiddleware(req, res, next) {
  // Skip if not GET request
  if (req.method !== 'GET') {
    return next();
  }
  
  // Check cache
  const cached = get(req);
  if (cached) {
    res.set('X-Cache', 'HIT');
    res.set('Content-Type', cached.contentType || 'text/html');
    return res.send(cached.body);
  }
  
  res.set('X-Cache', 'MISS');
  next();
}

// Log cache stats periodically
setInterval(() => {
  const stats = getStats();
  logger.info('Cache Stats', {
    keys: stats.keys,
    hits: stats.hits,
    misses: stats.misses,
    hitRate: (stats.hitRate * 100).toFixed(2) + '%',
  });
}, 300000); // Every 5 minutes

module.exports = {
  get,
  set,
  clear,
  getStats,
  shouldCache,
  cacheMiddleware,
};




