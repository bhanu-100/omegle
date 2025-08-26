const winston = require('winston');
const path = require('path');

// Custom log levels with colors
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
};

const logColors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  debug: 'blue',
  trace: 'magenta'
};

winston.addColors(logColors);

// Custom format for structured logging
const customFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss.SSS'
  }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    // Clean up meta object
    const cleanMeta = Object.keys(meta).length > 0 ? meta : {};
    
    // Add worker ID if not present
    if (!cleanMeta.worker && typeof process !== 'undefined') {
      cleanMeta.worker = process.pid;
    }

    const logEntry = {
      timestamp,
      level,
      message,
      ...cleanMeta
    };

    return JSON.stringify(logEntry);
  })
);

// Development-friendly console format
const consoleFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'HH:mm:ss.SSS'
  }),
  winston.format.colorize(),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, worker, ...meta }) => {
    const workerInfo = worker ? `[${worker}]` : '';
    const metaInfo = Object.keys(meta).length > 0 ? 
      `\n${JSON.stringify(meta, null, 2)}` : '';
    
    return `${timestamp} ${level} ${workerInfo}: ${message}${metaInfo}`;
  })
);

// Create transports array
const transports = [];

// Console transport (always enabled)
transports.push(
  new winston.transports.Console({
    format: process.env.NODE_ENV === 'production' ? customFormat : consoleFormat,
    handleExceptions: true,
    handleRejections: true,
    silent: process.env.NODE_ENV === 'test'
  })
);

// File transports for production
if (process.env.NODE_ENV === 'production') {
  // Ensure logs directory exists
  const fs = require('fs');
  const logsDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // Combined log file
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: customFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true
    })
  );

  // Error log file
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: customFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true
    })
  );

  // Application log file (info and above)
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'app.log'),
      level: 'info',
      format: customFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 3,
      tailable: true
    })
  );
}

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  levels: logLevels,
  format: customFormat,
  transports,
  exitOnError: false,
  silent: process.env.NODE_ENV === 'test'
});

// Additional utility methods
logger.trace = (message, meta = {}) => {
  logger.log('trace', message, meta);
};

// Request logging middleware helper
logger.createRequestLogger = () => {
  return (req, res, next) => {
    const startTime = Date.now();
    
    // Log request start
    logger.info('HTTP Request Started', {
      method: req.method,
      url: req.url,
      userAgent: req.get('User-Agent'),
      ip: req.ip,
      requestId: req.id || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    });

    // Override res.end to log response
    const originalEnd = res.end;
    res.end = function(chunk, encoding) {
      const duration = Date.now() - startTime;
      
      logger.info('HTTP Request Completed', {
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        duration: `${duration}ms`,
        contentLength: res.get('content-length') || 0,
        ip: req.ip
      });

      originalEnd.call(res, chunk, encoding);
    };

    next();
  };
};

// Error logging with stack traces
logger.logError = (error, context = {}) => {
  logger.error(error.message || 'Unknown error', {
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: error.code
    },
    ...context
  });
};

// Performance logging
logger.logPerformance = (operation, duration, metadata = {}) => {
  const level = duration > 1000 ? 'warn' : 'debug';
  logger.log(level, `Performance: ${operation}`, {
    operation,
    duration: `${duration}ms`,
    slow: duration > 1000,
    ...metadata
  });
};

// Business event logging
logger.logBusinessEvent = (event, data = {}) => {
  logger.info(`Business Event: ${event}`, {
    businessEvent: event,
    timestamp: Date.now(),
    ...data
  });
};

// Security event logging
logger.logSecurityEvent = (event, details = {}) => {
  logger.warn(`Security Event: ${event}`, {
    securityEvent: event,
    timestamp: Date.now(),
    severity: details.severity || 'medium',
    ...details
  });
};

// Connection event logging
logger.logConnection = (action, userKey, socketId, metadata = {}) => {
  logger.info(`Connection ${action}`, {
    action,
    userKey,
    socketId,
    timestamp: Date.now(),
    ...metadata
  });
};

// Matchmaking event logging
logger.logMatchmaking = (action, userKey, peerKey = null, metadata = {}) => {
  logger.info(`Matchmaking ${action}`, {
    action,
    userKey,
    peerKey,
    timestamp: Date.now(),
    ...metadata
  });
};

// WebRTC signaling logging
logger.logSignaling = (signalType, from, to, metadata = {}) => {
  logger.debug(`WebRTC Signal: ${signalType}`, {
    signalType,
    from,
    to,
    timestamp: Date.now(),
    ...metadata
  });
};

// System health logging
logger.logHealth = (component, status, metrics = {}) => {
  const level = status === 'healthy' ? 'info' : 'warn';
  logger.log(level, `Health Check: ${component}`, {
    component,
    status,
    timestamp: Date.now(),
    ...metrics
  });
};

// Log rotation and cleanup for development
if (process.env.NODE_ENV === 'development') {
  logger.add(new winston.transports.File({
    filename: path.join(process.cwd(), 'logs', 'development.log'),
    format: customFormat,
    maxsize: 5 * 1024 * 1024, // 5MB
    maxFiles: 2,
    tailable: true
  }));
}

// Graceful shutdown logging
process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, initiating graceful shutdown', {
    worker: process.pid,
    timestamp: Date.now()
  });
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, initiating graceful shutdown', {
    worker: process.pid,
    timestamp: Date.now()
  });
});

// Uncaught exception handler
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', {
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack
    },
    worker: process.pid,
    fatal: true
  });
  
  // Give logger time to write before exit
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

// Unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason?.message || reason,
    stack: reason?.stack,
    promise: promise.toString(),
    worker: process.pid
  });
});

module.exports = logger;