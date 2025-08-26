# WebRTC Video Chat Application

A production-ready, scalable WebRTC video chat application built with React and Vite. Connect with random people through peer-to-peer video calls with real-time text chat.

## Features

### Core Features
- **WebRTC Peer-to-Peer Video/Audio**: Direct connection between users
- **Real-time Text Chat**: Instant messaging during video calls
- **Media Controls**: Toggle camera and microphone on/off
- **Auto Partner Finding**: Automatically connects you with available users
- **Connection Recovery**: Smart reconnection logic for dropped connections

### Advanced Features
- **Multiple STUN/TURN Server Support**: Reliable NAT traversal
- **Connection Quality Monitoring**: Real-time statistics and quality indicators
- **Responsive Design**: Works on desktop and mobile devices
- **Error Recovery**: Graceful handling of connection failures
- **Rate Limiting Protection**: Built-in protection against spam
- **Performance Monitoring**: Track connection health and bandwidth usage

### Technical Features
- **Production Socket.IO Client**: Custom implementation with intelligent queuing
- **Advanced WebRTC Management**: Connection state monitoring and recovery
- **Memory Optimization**: Message limiting and cleanup routines
- **Browser Compatibility**: Supports all modern browsers
- **PWA Ready**: Service worker support for offline functionality

## Quick Start

### Prerequisites
- Node.js 16+ 
- npm or yarn
- A WebRTC signaling server (backend not included in this repo)

### Installation

1. **Clone the repository**
```bash
git clone <your-repo-url>
cd webrtc-video-chat
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure environment**
```bash
cp .env.example .env
```

Edit `.env` with your backend server URL:
```env
VITE_API_URL=http://localhost:3000
```

4. **Start development server**
```bash
npm run dev
```

5. **Build for production**
```bash
npm run build
```

## Configuration

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `VITE_API_URL` | Backend server URL | Yes | - |
| `VITE_DEBUG_MODE` | Enable debug logging | No | `false` |
| `VITE_ENABLE_STATS` | Show connection statistics | No | `true` |
| `VITE_MAX_RECONNECT_ATTEMPTS` | Max socket reconnection attempts | No | `10` |

### TURN Server Configuration (Recommended for Production)

For reliable connections through firewalls and NATs, configure TURN servers:

```env
VITE_TURN_SERVER_URL=turn:your-turn-server.com:3478
VITE_TURN_USERNAME=username
VITE_TURN_CREDENTIAL=password
```

## Architecture

### Project Structure
```
src/
├── config/           # Configuration management
├── services/         # Core services (Socket, WebRTC)
├── utils/           # Utility functions and helpers  
├── App.jsx          # Main application component
├── main.jsx         # Application entry point
└── index.css        # Global styles and animations
```

### Core Services

#### Socket Client (`src/services/socketClient.js`)
- Production-ready Socket.IO client
- Automatic reconnection with exponential backoff
- Message queuing for offline scenarios
- Enhanced error handling and diagnostics

#### WebRTC Service (`src/services/webrtcService.js`)  
- Complete WebRTC peer connection management
- Media device handling and constraints
- Connection quality monitoring
- ICE candidate queuing and processing
- Stats collection and bandwidth monitoring

#### Configuration System (`src/config/index.js`)
- Environment-based configuration
- Browser capability detection
- ICE server management
- Feature flags and performance tuning

## Performance Considerations

### Scaling for 1000+ Users

The application is designed to handle high concurrent usage:

1. **Connection Pooling**: Efficient socket connection management
2. **Memory Management**: Automatic cleanup and message limiting
3. **ICE Server Load Balancing**: Multiple STUN servers configured
4. **TURN Server Integration**: Support for enterprise-grade TURN servers
5. **Error Recovery**: Intelligent reconnection and fallback mechanisms

### Optimization Features

- **Lazy Loading**: Components and resources loaded on demand
- **Debounced Operations**: Rate limiting for user actions
- **Message Queuing**: Offline message storage and transmission
- **Stats Throttling**: Efficient performance monitoring
- **Memory Cleanup**: Automatic cleanup of unused resources

## Browser Support

### Fully Supported
- Chrome 70+
- Firefox 65+  
- Safari 12+
- Edge 79+

### Mobile Support
- Chrome Mobile 70+
- Safari Mobile 12+
- Samsung Internet 10+

### Required Browser Features
- WebRTC (RTCPeerConnection)
- getUserMedia API
- WebSocket support
- ES2017+ (async/await)

## Development

### Available Scripts

```bash
# Development server with hot reload
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Run linting
npm run lint
```

### Debug Mode

Enable debug mode for development:
```env
VITE_DEBUG_MODE=true
```

This provides:
- Detailed console logging
- Global debug utilities (`window.socketDebug`, `window.webrtcDebug`)
- Performance monitoring
- Connection diagnostics

### Debugging Utilities

In debug mode, access these global utilities:

```javascript
// Socket debugging
window.socketDebug.health()      // Connection health
window.socketDebug.test()        // Test connection
window.socketDebug.reconnect()   // Force reconnection

// WebRTC debugging  
window.webrtcDebug.getState()    // Connection states
window.webrtcDebug.testICE()     // Test ICE servers

// General utilities
window.utils.network.checkConnectivity()  // Network test
window.utils.media.getDevices()           // Available devices
```

## Deployment

### Vercel (Recommended)
```bash
npm run build
# Deploy the dist/ folder to Vercel
```

### Netlify
```bash
npm run build
# Deploy the dist/ folder to Netlify  
```

### Self-hosted
```bash
npm run build
# Serve the dist/ folder with any static file server
```

### Environment Variables for Production

```env
VITE_API_URL=https://your-backend.herokuapp.com
VITE_DEBUG_MODE=false
VITE_ENABLE_STATS=true
VITE_TURN_SERVER_URL=turn:your-turn-server.com:3478
VITE_TURN_USERNAME=production_user
VITE_TURN_CREDENTIAL=secure_password
```

## Security Considerations

### Content Security Policy
Configure CSP headers for production:
```
connect-src 'self' wss://your-backend.com https://your-backend.com
media-src 'self'
```

### HTTPS Requirements
- WebRTC requires HTTPS in production
- Configure your backend with SSL/TLS
- Use WSS (secure WebSocket) for signaling

### Privacy Features
- No data storage or logging
- Peer-to-peer connections (no server relay)
- Automatic cleanup of sensitive data

## Troubleshooting

### Common Issues

1. **Camera/Microphone Access Denied**
   - Check browser permissions
   - Ensure HTTPS in production
   - Verify device availability

2. **Connection Failures**
   - Check TURN server configuration
   - Verify firewall settings
   - Test ICE server connectivity

3. **Audio/Video Quality Issues**
   - Check bandwidth requirements
   - Test different ICE servers
   - Monitor connection statistics

### Debug Tools

Use the built-in health checks:
```javascript
// Check overall application health
window.socketDebug.health()
window.webrtcDebug.getState()

// Test specific components
window.utils.network.checkConnectivity()
window.utils.webrtc.testICEServers()
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Submit a pull request

### Development Guidelines
- Follow the existing code style
- Add JSDoc comments for new functions
- Update tests for new features
- Ensure browser compatibility

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Backend Requirements

This frontend requires a WebRTC signaling server that handles:
- Socket.IO connections
- Room/match management  
- WebRTC signaling (offer/answer/ICE candidates)
- User matching and rate limiting

Example backend events the server should handle:
- `find_match` - Find available partner
- `webrtc_offer` - WebRTC offer signaling
- `webrtc_answer` - WebRTC answer signaling  
- `webrtc_ice_candidate` - ICE candidate exchange
- `message` - Text chat messages
- `skip` - Skip current partner

## Support

For issues and questions:
1. Check the troubleshooting guide above
2. Review browser console logs (debug mode)
3. Test with the built-in diagnostic tools
4. Open an issue with detailed information