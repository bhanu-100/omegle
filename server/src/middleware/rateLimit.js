const logger = require('../utils/logger');
const metrics = require('../monitoring/metrics');

class RateLimitMiddleware {
  constructor() {
    this.windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000;
    this.maxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 200;
    this.skipWhitelist = (process.env.RATE_LIMIT_WHITELIST || '').split(',').filter(ip => ip.trim());
    
    // In-memory store for rate limiting
    this.store = new Map();
    this.cleanupInterval = null;
    
    this.startCleanupTimer();
    logger.info('Rate limiting initialized', {
      windowMs: this.windowMs,
      maxRequests: this.maxRequests,
      whitelist: this.skipWhitelist,
      worker: process.pid
    });
  }

  middleware() {
    return (req, res, next) => {
      const key = this.getKey(req);
      
      // Skip whitelisted IPs
      if (this.skipWhitelist.includes(key)) {
        return next();
      }

      // Skip health check endpoints
      if (this.shouldSkip(req)) {
        return next();
      }

      const now = Date.now();
      const windowStart = now - this.windowMs;
      
      // Get or create rate limit entry
      if (!this.store.has(key)) {
        this.store.set(key, []);
      }
      
      const requests = this.store.get(key);
      
      // Remove old requests outside the window
      while (requests.length > 0 && requests[0] < windowStart) {
        requests.shift();
      }
      
      // Check if limit exceeded
      if (requests.length >= this.maxRequests) {
        metrics.rateLimitHits.inc({ worker: process.pid });
        
        logger.warn('Rate limit exceeded', {
          key,
          requestCount: requests.length,
          maxRequests: this.maxRequests,
          windowMs: this.windowMs,
          userAgent: req.get('User-Agent'),
          url: req.url,
          worker: process.pid
        });
        
        return this.sendRateLimitResponse(res, requests.length);
      }
      
      // Add current request
      requests.push(now);
      
      // Add rate limit headers
      this.addHeaders(res, requests.length);
      
      next();
    };
  }

  getKey(req) {
    // Use X-Forwarded-For if available (behind proxy)
    const forwardedFor = req.get('X-Forwarded-For');
    if (forwardedFor) {
      return forwardedFor.split(',')[0].trim();
    }
    
    // Use X-Real-IP if available
    const realIP = req.get('X-Real-IP');
    if (realIP) {
      return realIP.trim();
    }
    
    // Fall back to connection remote address
    return req.connection.remoteAddress || req.ip || 'unknown';
  }

  shouldSkip(req) {
    const skipPaths = [
      '/health',
      '/metrics',
      '/favicon.ico'
    ];
    
    return skipPaths.some(path => req.url.startsWith(path));
  }

  sendRateLimitResponse(res, currentRequests) {
    const resetTime = Date.now() + this.windowMs;
    const retryAfter = Math.ceil(this.windowMs / 1000);
    
    res.set({
      'X-RateLimit-Limit': this.maxRequests,
      'X-RateLimit-Remaining': 0,
      'X-RateLimit-Reset': new Date(resetTime).toISOString(),
      'Retry-After': retryAfter
    });
    
    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
      details: {
        limit: this.maxRequests,
        windowMs: this.windowMs,
        retryAfter: retryAfter
      },
      timestamp: new Date().toISOString()
    });
  }

  addHeaders(res, currentRequests) {
    const remaining = Math.max(0, this.maxRequests - currentRequests);
    const resetTime = Date.now() + this.windowMs;
    
    res.set({
      'X-RateLimit-Limit': this.maxRequests,
      'X-RateLimit-Remaining': remaining,
      'X-RateLimit-Reset': new Date(resetTime).toISOString()
    });
  }

  startCleanupTimer() {
    // Clean up old entries every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);
  }

  cleanup() {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    let entriesRemoved = 0;
    
    for (const [key, requests] of this.store.entries()) {
      // Remove old requests
      while (requests.length > 0 && requests[0] < windowStart) {
        requests.shift();
      }
      
      // Remove empty entries
      if (requests.length === 0) {
        this.store.delete(key);
        entriesRemoved++;
      }
    }
    
    if (entriesRemoved > 0) {
      logger.debug('Rate limit cleanup completed', {
        entriesRemoved,
        activeEntries: this.store.size,
        worker: process.pid
      });
    }
  }

  // Get current statistics
  getStats() {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    
    let totalActiveRequests = 0;
    let activeIPs = 0;
    const ipStats = [];
    
    for (const [key, requests] of this.store.entries()) {
      // Filter to current window
      const activeRequests = requests.filter(timestamp => timestamp >= windowStart);
      
      if (activeRequests.length > 0) {
        activeIPs++;
        totalActiveRequests += activeRequests.length;
        
        ipStats.push({
          ip: key,
          requests: activeRequests.length,
          remaining: Math.max(0, this.maxRequests - activeRequests.length),
          lastRequest: new Date(Math.max(...activeRequests)).toISOString()
        });
      }
    }
    
    return {
      windowMs: this.windowMs,
      maxRequests: this.maxRequests,
      activeIPs,
      totalActiveRequests,
      avgRequestsPerIP: activeIPs > 0 ? Math.round(totalActiveRequests / activeIPs) : 0,
      topIPs: ipStats
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 10) // Top 10 most active IPs
    };
  }

  // Administrative functions
  resetIP(ip) {
    if (this.store.has(ip)) {
      this.store.delete(ip);
      logger.info('Rate limit reset for IP', { ip, worker: process.pid });
      return true;
    }
    return false;
  }

  blockIP(ip, durationMs = this.windowMs) {
    const blockUntil = Date.now() + durationMs;
    const requests = Array(this.maxRequests).fill(blockUntil);
    this.store.set(ip, requests);
    
    logger.warn('IP blocked by rate limiter', {
      ip,
      blockUntil: new Date(blockUntil).toISOString(),
      worker: process.pid
    });
  }

  isBlocked(ip) {
    if (!this.store.has(ip)) {
      return false;
    }
    
    const requests = this.store.get(ip);
    const now = Date.now();
    const windowStart = now - this.windowMs;
    
    // Remove old requests
    while (requests.length > 0 && requests[0] < windowStart) {
      requests.shift();
    }
    
    return requests.length >= this.maxRequests;
  }

  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    logger.info('Rate limit middleware shutdown', {
      finalStats: this.getStats(),
      worker: process.pid
    });
    
    this.store.clear();
  }
}

// Create singleton instance
const rateLimitInstance = new RateLimitMiddleware();

// Export middleware function and instance
module.exports = rateLimitInstance.middleware();
module.exports.rateLimiter = rateLimitInstance;