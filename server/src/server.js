require('dotenv').config();
const cluster = require('cluster');
const os = require('os');
const logger = require('./utils/logger');
const {setupGracefulShutdown} = require('./utils/shutdown');

const {
  NODE_ENV = 'development',
  CLUSTER_WORKERS = 2,
  PORT = 3000
} = process.env;

// Master process - cluster management
if (cluster.isMaster && NODE_ENV === 'production') {
  logger.info(`Master ${process.pid} starting...`);
  
  const numWorkers = parseInt(CLUSTER_WORKERS) || os.cpus().length;
  logger.info(`Starting ${numWorkers} workers`);
  
  // Fork workers
  for (let i = 0; i < numWorkers; i++) {
    const worker = cluster.fork();
    worker.on('message', (msg) => {
      if (msg.type === 'health') {
        logger.debug(`Health check from worker ${worker.process.pid}:`, msg.data);
      }
    });
  }

  // Handle worker crashes
  cluster.on('exit', (worker, code, signal) => {
    logger.warn(`Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    const newWorker = cluster.fork();
    
    newWorker.on('message', (msg) => {
      if (msg.type === 'health') {
        logger.debug(`Health check from worker ${newWorker.process.pid}:`, msg.data);
      }
    });
  });

  // Graceful shutdown for master
  const shutdownMaster = (signal) => {
    logger.info(`Master received ${signal}, shutting down workers...`);
    
    for (const id in cluster.workers) {
      cluster.workers[id].kill('SIGTERM');
    }

    setTimeout(() => {
      logger.warn('Force killing remaining workers');
      for (const id in cluster.workers) {
        cluster.workers[id].kill('SIGKILL');
      }
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdownMaster('SIGTERM'));
  process.on('SIGINT', () => shutdownMaster('SIGINT'));

} else {
  // Worker process
  logger.info(`Worker ${process.pid} starting...`);
  
  const app = require('./app');
  const server = require('http').createServer(app);
  const socketHandler = require('./socket/socketHandler');
  
  // Initialize Socket.IO
  socketHandler.init(server);
  
  server.listen(PORT, () => {
    logger.info(`Worker ${process.pid} listening on port ${PORT}`);
    
    // Send health status to master
    if (cluster.isWorker) {
      process.send({
        type: 'health',
        data: {
          worker: process.pid,
          status: 'ready',
          port: PORT
        }
      });
    }
  });

  // Graceful shutdown for workers
  setupGracefulShutdown(server, socketHandler);
}