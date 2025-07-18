import { useEffect, useState, useRef } from 'react';
import socket from './socket';
import './App.css';

function App() {
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);

  const ICE_SERVERS = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  };

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [statusMessage, setStatusMessage] = useState("Looking for a partner...");

  const startVideoChat = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideoRef.current.srcObject = stream;
    localStreamRef.current = stream;

    peerConnectionRef.current = new RTCPeerConnection(ICE_SERVERS);

    stream.getTracks().forEach((track) => {
      peerConnectionRef.current.addTrack(track, stream);
    });

    peerConnectionRef.current.ontrack = (event) => {
      remoteVideoRef.current.srcObject = event.streams[0];
    };

    peerConnectionRef.current.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', event.candidate);
      }
    };
  };

  const toggleMic = () => {
    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    if (audioTrack) audioTrack.enabled = !audioTrack.enabled;
  };

  const toggleCamera = () => {
    const videoTrack = localStreamRef.current?.getVideoTracks()[0];
    if (videoTrack) videoTrack.enabled = !videoTrack.enabled;
  };

  useEffect(() => {
    socket.connect();

    socket.on('connect', () => {
      socket.emit('join');
    });

    socket.on('waiting', () => {
      setWaiting(true);
      setStatusMessage("🕒 Waiting for a partner...");
    });

    socket.on('partner-found', async () => {
      setWaiting(false);
      setConnected(true);
      setMessages([]);
      setStatusMessage("✅ Connected! Say hi 👋");

      await startVideoChat();

      const offer = await peerConnectionRef.current.createOffer();
      await peerConnectionRef.current.setLocalDescription(offer);
      socket.emit('offer', offer);
    });

    socket.on('message', (data) => {
      setMessages((prev) => [...prev, { sender: 'stranger', text: data }]);
    });

    socket.on('partner-disconnected', () => {
      setConnected(false);
      setWaiting(true);
      setStatusMessage("❌ Partner disconnected. Looking for a new one...");
      setMessages((prev) => [...prev, { sender: 'system', text: 'Partner disconnected.' }]);

      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    });

    socket.on('offer', async (offer) => {
      await startVideoChat();
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(offer));

      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
      socket.emit('answer', answer);
    });

    socket.on('answer', async (answer) => {
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('ice-candidate', async (candidate) => {
      try {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error('ICE candidate error:', error);
      }
    });

    return () => {
      socket.removeAllListeners();
    };
  }, []);

  const sendMessage = () => {
    if (input.trim()) {
      socket.emit('message', input);
      setMessages((prev) => [...prev, { sender: 'me', text: input }]);
      setInput('');
    }
  };

  const handleSkip = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localVideoRef.current.srcObject = null;
      remoteVideoRef.current.srcObject = null;
    }

    socket.emit('skip');
    setMessages([]);
    setConnected(false);
    setWaiting(true);
    setStatusMessage("⏩ Skipped! Searching for a new partner...");
  };

  return (
    <div className="app-container">
      <h2>🎥 Omegle Clone - Video & Text Chat</h2>

      <p className="status">{statusMessage}</p>

      <div className="video-container">
        <div>
          <h4>You</h4>
          <video ref={localVideoRef} autoPlay playsInline muted />
        </div>
        <div>
          <h4>Stranger</h4>
          <video ref={remoteVideoRef} autoPlay playsInline />
        </div>
      </div>

      <div className="controls">
        <button onClick={toggleMic}>🎤 Toggle Mic</button>
        <button onClick={toggleCamera}>📷 Toggle Camera</button>
        {connected && (
          <button className="skip-btn" onClick={handleSkip}>
            ⏩ Skip
          </button>
        )}
      </div>

      <div className="chat-box">
        {messages.map((msg, i) => (
          <p key={i}><strong>{msg.sender}:</strong> {msg.text}</p>
        ))}
      </div>

      <div className="input-group">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
          disabled={!connected}
          placeholder="Type a message..."
        />
        <button onClick={sendMessage} disabled={!connected}>
          Send
        </button>
      </div>
    </div>
  );
}

export default App;
