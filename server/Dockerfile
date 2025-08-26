# Multi-stage build for WebRTC Chat Service

FROM node:18-alpine AS base

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
FROM base AS dependencies

# Install all dependencies (including dev dependencies for build)
RUN npm ci --only=production && npm cache clean --force

# Create a separate stage for dev dependencies
FROM base AS dev-dependencies
RUN npm ci

# Production stage
FROM base AS production

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S webrtc -u 1001

# Copy production node_modules
COPY --from=dependencies /app/node_modules ./node_modules

# Copy application source
COPY --chown=webrtc:nodejs . .

# Create logs directory
RUN mkdir -p logs && chown webrtc:nodejs logs

# Switch to non-root user
USER webrtc

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "const http = require('http'); const options = { host: 'localhost', port: process.env.PORT || 3000, path: '/health', timeout: 5000 }; const req = http.request(options, (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }); req.on('error', () => process.exit(1)); req.end();"

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "src/server.js"]

FROM dev-dependencies AS development

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S webrtc -u 1001

USER root
COPY --chown=webrtc:nodejs . .
RUN mkdir -p logs && chown webrtc:nodejs logs

USER webrtc

CMD ["npm", "run", "dev"]
