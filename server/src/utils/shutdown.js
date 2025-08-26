const logger = require('./logger');

class GracefulShutdown {
  constructor() {
    this.isShuttingDown = false;
    this.shutdownTimeout = 10000; // 10 seconds
    this.services = [];
  }

  registerService(name, shutdownFn) {
    this.services.push({ name, shutdown: shutdownFn });
  }

  async shutdown(signal) {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress', { signal, worker: process.pid });
      return;
    }

    this.isShuttingDown = true;
    logger.info(`Graceful shutdown initiated by ${signal}`, {
      worker: process.pid,
      servicesCount: this.services.length
    });

    // Set a timeout to force exit if graceful shutdown takes too long
    const forceExitTimer = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit', {
        worker: process.pid,
        timeout: this.shutdownTimeout
      });
      process.exit(1);
    }, this.shutdownTimeout);

    try {
      // Shutdown services in reverse order (LIFO)
      const reversedServices = [...this.services].reverse();
      
      for (const service of reversedServices) {
        const startTime = Date.now();
        
        try {
          logger.info(`Shutting down service: ${service.name}`, {
            worker: process.pid
          });
          
          await Promise.race([
            service.shutdown(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`Service ${service.name} shutdown timeout`)), 5000)
            )
          ]);
          
          const duration = Date.now() - startTime;
          logger.info(`Service ${service.name} shutdown completed`, {
            duration: `${duration}ms`,
            worker: process.pid
          });
          
        } catch (error) {
          logger.error(`Failed to shutdown service ${service.name}`, {
            error: error.message,
            worker: process.pid
          });
        }
      }

      clearTimeout(forceExitTimer);
      logger.info('Graceful shutdown completed successfully', {
        worker: process.pid
      });
      
      process.exit(0);
      
    } catch (error) {
      clearTimeout(forceExitTimer);
      logger.error('Error during graceful shutdown', {
        error: error.message,
        stack: error.stack,
        worker: process.pid
      });
      
      process.exit(1);
    }
  }
}

const gracefulShutdown = new GracefulShutdown();

// Setup graceful shutdown for HTTP server and Socket.IO
function setupGracefulShutdown(server, socketHandler) {
  // Register HTTP server shutdown
  gracefulShutdown.registerService('HTTP Server', () => {
    return new Promise((resolve) => {
      server.close((err) => {
        if (err) {
          logger.error('Error closing HTTP server', {
            error: err.message,
            worker: process.pid
          });
        } else {
          logger.info('HTTP server closed', { worker: process.pid });
        }
        resolve();
      });
    });
  });

  // Register Socket.IO shutdown
  gracefulShutdown.registerService('Socket.IO', async () => {
    if (socketHandler && typeof socketHandler.shutdown === 'function') {
      await socketHandler.shutdown();
    }
  });

  // Handle shutdown signals
  process.on('SIGTERM', () => gracefulShutdown.shutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown.shutdown('SIGINT'));

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception - initiating shutdown', {
      error: error.message,
      stack: error.stack,
      worker: process.pid
    });
    
    gracefulShutdown.shutdown('UNCAUGHT_EXCEPTION');
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Promise Rejection - initiating shutdown', {
      reason: reason?.message || reason,
      stack: reason?.stack,
      worker: process.pid
    });
    
    gracefulShutdown.shutdown('UNHANDLED_REJECTION');
  });

  logger.info('Graceful shutdown handlers registered', {
    worker: process.pid,
    signals: ['SIGTERM', 'SIGINT']
  });
}

module.exports = {
  gracefulShutdown,
  setupGracefulShutdown
};