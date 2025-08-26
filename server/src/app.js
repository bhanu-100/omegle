const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const logger = require('./utils/logger');
const metrics = require('./monitoring/metrics');
const healthCheck = require('./routes/health');
const rateLimit = require('./middleware/rateLimit');

const app = express();

// Security middleware
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false
}));

// CORS configuration
app.use(cors({
  // origin: process.env.CLIENT_URL || '*',
  origin: '*',
  methods: ['GET', 'POST'],
  credentials: false,
  optionsSuccessStatus: 200
}));

// Compression
app.use(compression({
  level: 6,
  threshold: 1024
}));

// Body parsing
app.use(express.json({ 
  limit: '1mb',
  strict: true 
}));

app.use(express.urlencoded({ 
  extended: true,
  limit: '1mb'
}));

// Trust proxy
app.set('trust proxy', true);
app.disable('x-powered-by');

// Rate limiting middleware
app.use(rateLimit);

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info('HTTP Request', {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
  });
  
  next();
});

// Routes
app.use('/health', healthCheck);
app.use('/metrics', metrics.router);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'WebRTC Chat Service',
    version: '1.0.0',
    status: 'running',
    worker: process.pid,
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`,
    timestamp: new Date().toISOString()
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error in Express app', {
    err: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip
  });

  res.status(500).json({
    error: 'Internal Server Error',
    message: 'Something went wrong',
    timestamp: new Date().toISOString()
  });
});

module.exports = app;