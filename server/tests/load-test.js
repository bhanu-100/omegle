#!/usr/bin/env node

const { io } = require('socket.io-client');
const { performance } = require('perf_hooks');
const EventEmitter = require('events');

class LoadTester extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // this.serverUrl = 'https://omegle-e3ho.onrender.com/';
    this.serverUrl = options.serverUrl || 'http://localhost:3000';
    this.maxConnections = options.maxConnections || 100;
    this.concurrency = options.concurrency || 5;
    this.testDuration = options.testDuration || 60000; // 1 minute
    this.rampUpTime = options.rampUpTime || 30000; // 30 seconds
    
    this.connections = [];
    this.stats = {
      connectionsAttempted: 0,
      connectionsSuccessful: 0,
      connectionsFailed: 0,
      matchesFound: 0,
      matchesFailed: 0,
      signalingMessages: 0,
      errors: [],
      connectionTimes: [],
      matchTimes: [],
      disconnections: 0
    };
    
    this.isRunning = false;
    this.startTime = null;
  }

  async runLoadTest() {
    console.log('🚀 Starting WebRTC Chat Service Load Test');
    console.log(`   Target: ${this.serverUrl}`);
    console.log(`   Max Connections: ${this.maxConnections}`);
    console.log(`   Concurrency: ${this.concurrency}`);
    console.log(`   Test Duration: ${this.testDuration}ms`);
    console.log(`   Ramp-up Time: ${this.rampUpTime}ms`);
    console.log('');

    this.isRunning = true;
    this.startTime = performance.now();
    
    try {
      // Start connection monitoring
      this.startMonitoring();
      
      // Gradual ramp-up
      await this.rampUpConnections();
      
      // Hold connections for test duration
      console.log(`⏱️  Holding ${this.connections.length} connections for ${this.testDuration - this.rampUpTime}ms...`);
      await this.sleep(this.testDuration - this.rampUpTime);
      
      // Test complete
      await this.cleanup();
      this.printResults();
      
    } catch (error) {
      console.error('❌ Load test failed:', error.message);
      await this.cleanup();
    }
  }

  async rampUpConnections() {
    const rampUpSteps = Math.ceil(this.maxConnections / this.concurrency);
    const stepInterval = this.rampUpTime / rampUpSteps;
    
    console.log(`📈 Ramping up connections (${rampUpSteps} steps of ${this.concurrency})...`);
    
    for (let step = 0; step < rampUpSteps && this.isRunning; step++) {
      const connectionsInStep = Math.min(this.concurrency, this.maxConnections - this.connections.length);
      
      if (connectionsInStep <= 0) break;
      
      console.log(`   Step ${step + 1}/${rampUpSteps}: Creating ${connectionsInStep} connections...`);
      
      const promises = [];
      for (let i = 0; i < connectionsInStep; i++) {
        promises.push(this.createConnection());
      }
      
      await Promise.allSettled(promises);
      
      console.log(`   Active connections: ${this.connections.length}`);
      
      if (step < rampUpSteps - 1) {
        await this.sleep(stepInterval);
      }
    }
    
    console.log(`✅ Ramp-up complete! Active connections: ${this.connections.length}`);
  }

  async createConnection() {
    const connectionId = this.stats.connectionsAttempted++;
    const startTime = performance.now();
    
    return new Promise((resolve) => {
      const socket = io(this.serverUrl, {
        transports: ['websocket'],
        timeout: 10000,
        forceNew: true
      });

      const connectionData = {
        id: connectionId,
        socket,
        connected: false,
        matched: false,
        startTime,
        matchStartTime: null,
        signalCount: 0
      };

      // Connection established
      socket.on('connect', () => {
        const connectionTime = performance.now() - startTime;
        this.stats.connectionTimes.push(connectionTime);
        this.stats.connectionsSuccessful++;
        
        connectionData.connected = true;
        this.connections.push(connectionData);
        
        // Start matchmaking
        this.startMatchmaking(connectionData);
        
        resolve(connectionData);
      });

      // Connection failed
      socket.on('connect_error', (error) => {
        this.stats.connectionsFailed++;
        this.stats.errors.push(`Connection ${connectionId} failed: ${error.message}`);
        resolve(null);
      });

      // Matchmaking events
      socket.on('waiting', () => {
        console.log(`🔍 Connection ${connectionId} waiting for match...`);
      });

      socket.on('match_found', (data) => {
        if (connectionData.matchStartTime) {
          const matchTime = performance.now() - connectionData.matchStartTime;
          this.stats.matchTimes.push(matchTime);
        }
        
        this.stats.matchesFound++;
        connectionData.matched = true;
        
        console.log(`✨ Match found for connection ${connectionId}`);
        
        // Simulate WebRTC signaling
        this.simulateSignaling(connectionData);
      });

      socket.on('match_timeout', () => {
        this.stats.matchesFailed++;
        console.log(`⏰ Match timeout for connection ${connectionId}`);
      });

      // WebRTC signaling events
      socket.on('webrtc_offer', (data) => {
        connectionData.signalCount++;
        this.stats.signalingMessages++;
        
        // Respond with answer
        setTimeout(() => {
          socket.emit('webrtc_answer', {
            sdp: 'mock-sdp-answer',
            type: 'answer'
          });
        }, Math.random() * 100);
      });

      socket.on('webrtc_answer', (data) => {
        connectionData.signalCount++;
        this.stats.signalingMessages++;
      });

      socket.on('webrtc_ice_candidate', (data) => {
        connectionData.signalCount++;
        this.stats.signalingMessages++;
      });

      // Error handling
      socket.on('error', (error) => {
        this.stats.errors.push(`Socket ${connectionId} error: ${error}`);
      });

      socket.on('disconnect', (reason) => {
        this.stats.disconnections++;
        console.log(`🔌 Connection ${connectionId} disconnected: ${reason}`);
        
        // Remove from active connections
        const index = this.connections.findIndex(conn => conn.id === connectionId);
        if (index !== -1) {
          this.connections.splice(index, 1);
        }
      });

      socket.on('rate_limited', () => {
        this.stats.errors.push(`Connection ${connectionId} rate limited`);
        console.warn(`⚠️  Connection ${connectionId} rate limited`);
      });

      // Timeout fallback
      setTimeout(() => {
        if (!connectionData.connected) {
          socket.disconnect();
          this.stats.connectionsFailed++;
          resolve(null);
        }
      }, 15000);
    });
  }

  startMatchmaking(connectionData) {
    connectionData.matchStartTime = performance.now();
    connectionData.socket.emit('find_match');
  }

  simulateSignaling(connectionData) {
    const socket = connectionData.socket;
    
    // Send initial offer
    setTimeout(() => {
      socket.emit('webrtc_offer', {
        sdp: 'mock-sdp-offer',
        type: 'offer'
      });
    }, 100);

    // Send ICE candidates periodically
    const iceInterval = setInterval(() => {
      if (!connectionData.matched || !connectionData.connected) {
        clearInterval(iceInterval);
        return;
      }
      
      socket.emit('webrtc_ice_candidate', {
        candidate: 'mock-ice-candidate',
        sdpMLineIndex: 0,
        sdpMid: 'data'
      });
    }, 2000);

    // Clean up after 30 seconds
    setTimeout(() => {
      clearInterval(iceInterval);
    }, 30000);
  }

  startMonitoring() {
    const monitoringInterval = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(monitoringInterval);
        return;
      }
      
      this.printProgress();
    }, 5000); // Every 5 seconds
  }

  printProgress() {
    const elapsed = performance.now() - this.startTime;
    const elapsedSeconds = Math.round(elapsed / 1000);
    
    console.log(`📊 Progress (${elapsedSeconds}s):`);
    console.log(`   Active: ${this.connections.length}`);
    console.log(`   Successful: ${this.stats.connectionsSuccessful}`);
    console.log(`   Failed: ${this.stats.connectionsFailed}`);
    console.log(`   Matches: ${this.stats.matchesFound}`);
    console.log(`   Signals: ${this.stats.signalingMessages}`);
    console.log(`   Errors: ${this.stats.errors.length}`);
    console.log('');
  }

  printResults() {
    const totalTime = performance.now() - this.startTime;
    const totalTimeSeconds = totalTime / 1000;
    
    console.log('');
    console.log('🏁 LOAD TEST RESULTS');
    console.log('='.repeat(50));
    console.log(`Total Test Time: ${totalTimeSeconds.toFixed(2)}s`);
    console.log(`Target Server: ${this.serverUrl}`);
    console.log('');
    
    // Connection statistics
    console.log('📈 CONNECTION STATISTICS:');
    console.log(`   Attempted: ${this.stats.connectionsAttempted}`);
    console.log(`   Successful: ${this.stats.connectionsSuccessful}`);
    console.log(`   Failed: ${this.stats.connectionsFailed}`);
    console.log(`   Success Rate: ${((this.stats.connectionsSuccessful / this.stats.connectionsAttempted) * 100).toFixed(2)}%`);
    console.log(`   Final Active: ${this.connections.length}`);
    console.log('');
    
    // Connection timing
    if (this.stats.connectionTimes.length > 0) {
      const avgConnectionTime = this.stats.connectionTimes.reduce((a, b) => a + b, 0) / this.stats.connectionTimes.length;
      const minConnectionTime = Math.min(...this.stats.connectionTimes);
      const maxConnectionTime = Math.max(...this.stats.connectionTimes);
      
      console.log('⏱️  CONNECTION TIMING:');
      console.log(`   Average: ${avgConnectionTime.toFixed(2)}ms`);
      console.log(`   Minimum: ${minConnectionTime.toFixed(2)}ms`);
      console.log(`   Maximum: ${maxConnectionTime.toFixed(2)}ms`);
      console.log('');
    }
    
    // Matchmaking statistics
    console.log('🎯 MATCHMAKING STATISTICS:');
    console.log(`   Matches Found: ${this.stats.matchesFound}`);
    console.log(`   Matches Failed: ${this.stats.matchesFailed}`);
    console.log(`   Match Success Rate: ${this.stats.connectionsSuccessful > 0 ? 
      ((this.stats.matchesFound / this.stats.connectionsSuccessful) * 100).toFixed(2) : 0}%`);
    console.log('');
    
    // Match timing
    if (this.stats.matchTimes.length > 0) {
      const avgMatchTime = this.stats.matchTimes.reduce((a, b) => a + b, 0) / this.stats.matchTimes.length;
      const minMatchTime = Math.min(...this.stats.matchTimes);
      const maxMatchTime = Math.max(...this.stats.matchTimes);
      
      console.log('🏃 MATCH TIMING:');
      console.log(`   Average: ${avgMatchTime.toFixed(2)}ms`);
      console.log(`   Minimum: ${minMatchTime.toFixed(2)}ms`);
      console.log(`   Maximum: ${maxMatchTime.toFixed(2)}ms`);
      console.log('');
    }
    
    // Signaling statistics
    console.log('📡 SIGNALING STATISTICS:');
    console.log(`   Total Messages: ${this.stats.signalingMessages}`);
    console.log(`   Messages/Second: ${(this.stats.signalingMessages / totalTimeSeconds).toFixed(2)}`);
    console.log('');
    
    // Error statistics
    console.log('❌ ERROR STATISTICS:');
    console.log(`   Total Errors: ${this.stats.errors.length}`);
    console.log(`   Disconnections: ${this.stats.disconnections}`);
    
    if (this.stats.errors.length > 0) {
      console.log('   Sample Errors:');
      this.stats.errors.slice(0, 5).forEach(error => {
        console.log(`     - ${error}`);
      });
      if (this.stats.errors.length > 5) {
        console.log(`     ... and ${this.stats.errors.length - 5} more`);
      }
    }
    
    console.log('');
    console.log('='.repeat(50));
    
    // Performance assessment
    const successRate = (this.stats.connectionsSuccessful / this.stats.connectionsAttempted) * 100;
    if (successRate >= 95) {
      console.log('✅ EXCELLENT: Success rate >= 95%');
    } else if (successRate >= 90) {
      console.log('🟡 GOOD: Success rate >= 90%');
    } else if (successRate >= 80) {
      console.log('🟠 FAIR: Success rate >= 80%');
    } else {
      console.log('🔴 POOR: Success rate < 80%');
    }
  }

  async cleanup() {
    console.log('🧹 Cleaning up connections...');
    this.isRunning = false;
    
    const cleanupPromises = this.connections.map(conn => {
      return new Promise((resolve) => {
        if (conn.socket && conn.socket.connected) {
          conn.socket.disconnect();
        }
        setTimeout(resolve, 100);
      });
    });
    
    await Promise.allSettled(cleanupPromises);
    this.connections = [];
    console.log('✨ Cleanup complete');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  
  // Parse command line arguments
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace('--', '');
    const value = args[i + 1];
    
    if (key && value) {
      if (['maxConnections', 'concurrency', 'testDuration', 'rampUpTime'].includes(key)) {
        options[key] = parseInt(value);
      } else if (key === 'serverUrl') {
        options[key] = value;
      }
    }
  }
  
  console.log('WebRTC Chat Service Load Tester');
  console.log('Usage: node load-test.js [options]');
  console.log('Options:');
  console.log('  --serverUrl <url>        Server URL (default: http://localhost:3000)');
  console.log('  --maxConnections <num>   Max connections (default: 1000)');
  console.log('  --concurrency <num>      Concurrent connections per step (default: 50)');
  console.log('  --testDuration <ms>      Total test duration in ms (default: 60000)');
  console.log('  --rampUpTime <ms>        Ramp-up time in ms (default: 30000)');
  console.log('');
  
  const tester = new LoadTester(options);
  
  // Handle Ctrl+C gracefully
  process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT, stopping test...');
    await tester.cleanup();
    process.exit(0);
  });
  
  // Start the test 
  tester.runLoadTest().catch(console.error);
}

module.exports = LoadTester;