# WebRTC Chat Service

A high-performance, scalable WebRTC chat service built with Node.js, Socket.IO, Redis, and Kafka. Designed to handle 1000+ concurrent users with horizontal scaling capabilities.

## 🚀 Features

- **High Performance**: Optimized for 1000+ concurrent connections
- **Horizontal Scaling**: Cluster mode with multiple workers
- **Real-time Matchmaking**: Intelligent peer matching system
- **WebRTC Signaling**: Complete WebRTC offer/answer/ICE candidate handling
- **Redis Integration**: Session storage and pub/sub messaging
- **Kafka Streaming**: Event logging and analytics
- **Comprehensive Monitoring**: Prometheus metrics and health checks
- **Rate Limiting**: Built-in DDoS protection
- **Graceful Shutdown**: Clean resource cleanup
- **Docker Support**: Complete containerization with monitoring stack

## 📋 Requirements

- Node.js 18+ 
- Redis 6+
- Apache Kafka 2.8+ (optional)
- Docker & Docker Compose (for containerized deployment)

## 🛠️ Quick Start

### Using Docker Compose (Recommended)

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd webrtc-chat-service
   ```

2. **Start the services**
   ```bash
   docker-compose up -d
   ```

3. **Verify deployment**
   ```bash
   curl http://localhost:3000/health
   ```

4. **Access monitoring dashboards**
   - Service: http://localhost:3000
   - Grafana: http://localhost:3001 (admin/admin123)
   - Prometheus: http://localhost:9090
   - Redis Insight: http://localhost:8001

### Manual Installation

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Start Redis and Kafka**
   ```bash
   # Redis
   redis-server

   # Kafka (with Zookeeper)
   # Follow Kafka documentation for setup
   ```

4. **Start the service**
   ```bash
   # Development
   npm run dev

   # Production
   npm start
   ```

## ⚙️ Configuration

### Environment Variables

```bash
# Server Configuration
NODE_ENV=production
PORT=3000
CLIENT_URL=http://localhost:3001

# Clustering
CLUSTER_WORKERS=4
MAX_CONNECTIONS_PER_WORKER=300

# Redis Configuration
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=
REDIS_POOL_SIZE=8
REDIS_TTL_SOCKET_MAP=7200
REDIS_TTL_MATCH_MAP=3600
REDIS_TTL_USER_STATS=172800

# Kafka Configuration (Optional)
KAFKA_BROKERS=localhost:9092
KAFKA_TOPIC_EVENTS=webrtc-events
KAFKA_BATCH_SIZE=100
KAFKA_BATCH_TIMEOUT=1000

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=200

# Socket.IO Configuration
SOCKET_IO_TRANSPORTS=websocket,polling
SOCKET_IO_PING_TIMEOUT=30000
SOCKET_IO_PING_INTERVAL=15000

# Logging
LOG_LEVEL=info
```

### Performance Tuning for 1K Users

```bash
# Node.js optimization
NODE_OPTIONS="--max-old-space-size=2048 --gc-interval=100"
UV_THREADPOOL_SIZE=16

# Cluster configuration
CLUSTER_WORKERS=4
MAX_CONNECTIONS_PER_WORKER=300

# Redis optimization
REDIS_POOL_SIZE=8

# Rate limiting
RATE_LIMIT_MAX_REQUESTS=200
```

## 🔧 API Endpoints

### Health Checks
- `GET /health` - Basic health status
- `GET /health/detailed` - Detailed service health
- `GET /health/ready` - Kubernetes readiness probe
- `GET /health/live` - Kubernetes liveness probe

### Monitoring
- `GET /metrics` - Prometheus metrics
- `GET /metrics/business` - Business metrics
- `GET /health/system` - System information
- `GET /health/connections` - Connection statistics

## 🔌 Socket.IO Events

### Client → Server
```javascript
// Matchmaking
socket.emit('find_match');
socket.emit('cancel_match');

// WebRTC Signaling
socket.emit('webrtc_offer', { sdp, type });
socket.emit('webrtc_answer', { sdp, type });
socket.emit('webrtc_ice_candidate', { candidate, sdpMLineIndex, sdpMid });
```

### Server → Client
```javascript
// Matchmaking
socket.on('waiting', (data) => { /* User in queue */ });
socket.on('match_found', (data) => { /* Match found */ });
socket.on('match_timeout', (data) => { /* Match timeout */ });

// WebRTC Signaling
socket.on('webrtc_offer', (data) => { /* Received offer */ });
socket.on('webrtc_answer', (data) => { /* Received answer */ });
socket.on('webrtc_ice_candidate', (data) => { /* ICE candidate */ });

// Connection Management
socket.on('peer_disconnected', (data) => { /* Peer left */ });
socket.on('rate_limited', (data) => { /* Rate limit hit */ });
```

## 🧪 Testing

### Unit Tests
```bash
npm test
```

### Load Testing
```bash
# Test with 1000 concurrent connections
npm run test:load

# Custom load test
node tests/load-test.js --maxConnections 1000 --concurrency 50
```

### Load Test Options
```bash
--serverUrl <url>        # Server URL (default: http://localhost:3000)
--maxConnections <num>   # Max connections (default: 1000)
--concurrency <num>      # Concurrent connections per step (default: 50)
--testDuration <ms>      # Total test duration (default: 60000)
--rampUpTime <ms>        # Ramp-up time (default: 30000)
```

## 📊 Monitoring & Metrics

### Prometheus Metrics
- `webrtc_active_connections` - Current active connections
- `webrtc_total_connections` - Total connections established
- `webrtc_matchmaking_duration_seconds` - Matchmaking latency
- `webrtc_signaling_messages_total` - Signaling messages processed
- `webrtc_errors_total` - Error counts by type
- `redis_operation_duration_seconds` - Redis operation latency

### Grafana Dashboards
The service includes pre-configured Grafana dashboards for:
- Connection metrics
- Matchmaking performance
- WebRTC signaling statistics
- Infrastructure health
- Business KPIs

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Load Balancer │────│  WebRTC Service │────│  Redis Cluster  │
│    (Nginx)      │    │   (Clustered)   │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                │
                                │
                       ┌─────────────────┐    ┌─────────────────┐
                       │  Kafka Cluster  │    │   Monitoring    │
                       │   (Optional)    │    │ (Prometheus +   │
                       │                 │    │   Grafana)      │
                       └─────────────────┘    └─────────────────┘
```

### Component Responsibilities

- **HTTP Server (Express)**: API endpoints, health checks
- **Socket.IO**: WebSocket connections, real-time communication
- **Redis**: Session storage, pub/sub, matchmaking queues
- **Kafka**: Event streaming, analytics, audit logs
- **Prometheus**: Metrics collection
- **Grafana**: Metrics visualization

## 🚀 Deployment

### Docker Production Deployment

1. **Production environment file**
   ```bash
   cp .env.example .env.production
   # Configure production values
   ```

2. **Deploy with production compose**
   ```bash
   docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
   ```

### Kubernetes Deployment

See `k8s/` directory for Kubernetes manifests:
- Deployment configurations
- Service definitions
- ConfigMaps and Secrets
- HorizontalPodAutoscaler
- Ingress configuration

### Scaling Guidelines

| Users | Workers | Redis Pool | Memory | CPU |
|-------|---------|------------|--------|-----|
| 100   | 1       | 3          | 512MB  | 0.5 |
| 500   | 2       | 5          | 1GB    | 1.0 |
| 1000  | 4       | 8          | 2GB    | 2.0 |
| 2000+ | 6+      | 10+        | 4GB+   | 4.0+|

## 🔒 Security

- Rate limiting per IP
- Input validation and sanitization  
- WebSocket connection limits
- Secure headers (via Helmet.js)
- Environment variable validation
- Process isolation (non-root user)

## 🐛 Troubleshooting

### Common Issues

**High memory usage**
```bash
# Adjust Node.js heap size
NODE_OPTIONS="--max-old-space-size=2048"
```

**Connection drops**
```bash
# Increase connection limits
MAX_CONNECTIONS_PER_WORKER=500
SOCKET_IO_PING_TIMEOUT=60000
```

**Redis connection issues**
```bash
# Check Redis pool configuration
REDIS_POOL_SIZE=8
REDIS_URL=redis://localhost:6379
```

### Debugging

```bash
# Enable debug logging
LOG_LEVEL=debug

# Check health status
curl http://localhost:3000/health/detailed

# View metrics
curl http://localhost:3000/metrics
```

## 📝 Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🔗 Links

- [Socket.IO Documentation](https://socket.io/docs/)
- [WebRTC API Documentation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [Redis Documentation](https://redis.io/documentation)
- [Apache Kafka Documentation](https://kafka.apache.org/documentation/)
- [Prometheus Documentation](https://prometheus.io/docs/)

---

**Built with ❤️ for scalable real-time communication**