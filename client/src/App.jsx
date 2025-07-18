import { useEffect, useState, useRef } from 'react';
import socket from './socket';
import './App.css';

function App() {
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const iceCandidatesQueue = useRef([]);

  const ICE_SERVERS = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  };

  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [statusMessage, setStatusMessage] = useState("Looking for a partner...");

  const applyQueuedCandidates = async () => {
    for (const candidate of iceCandidatesQueue.current) {
      try {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error("Error applying queued candidate", err);
      }
    }
    iceCandidatesQueue.current = [];
  };

  const startVideoChat = async () => {
    if (peerConnectionRef.current) return;

    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideoRef.current.srcObject = stream;
    localStreamRef.current = stream;

    const peer = new RTCPeerConnection(ICE_SERVERS);
    peerConnectionRef.current = peer;

    stream.getTracks().forEach((track) => {
      peer.addTrack(track, stream);
    });

    peer.ontrack = (event) => {
      remoteVideoRef.current.srcObject = event.streams[0];
    };

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', event.candidate);
      }
    };
  };

  const toggleMic = () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setMicEnabled(audioTrack.enabled);
    }
  };

  const toggleCamera = () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      setCameraEnabled(videoTrack.enabled);
    }
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
        localStreamRef.current.getTracks().forEach(track => track.stop());
        localStreamRef.current = null;
      }

      localVideoRef.current.srcObject = null;
      remoteVideoRef.current.srcObject = null;
    });

    socket.on('offer', async (offer) => {
      await startVideoChat();

      if (peerConnectionRef.current.signalingState !== "stable") {
        console.warn("Connection not stable. Skipping setRemoteDescription");
        return;
      }

      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
      socket.emit('answer', answer);

      await applyQueuedCandidates();
    });

    socket.on('answer', async (answer) => {
      if (peerConnectionRef.current.signalingState === 'have-local-offer') {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
        await applyQueuedCandidates();
      } else {
        console.warn("Ignoring answer, wrong signaling state.");
      }
    });

    socket.on("ice-candidate", async (candidate) => {
      try {
        if (!candidate || !candidate.candidate) return;

        const iceCandidate = new RTCIceCandidate(candidate);

        if (peerConnectionRef.current?.remoteDescription) {
          await peerConnectionRef.current.addIceCandidate(iceCandidate);
        } else {
          iceCandidatesQueue.current.push(candidate);
        }
      } catch (error) {
        console.error("ICE candidate error:", error);
      }
    });

    return () => {
      socket.removeAllListeners();
      if (peerConnectionRef.current) peerConnectionRef.current.close();
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
        <button onClick={toggleMic}>
          {micEnabled ? "🎤 Mute Mic" : "🔇 Unmute Mic"}
        </button>
        <button onClick={toggleCamera}>
          {cameraEnabled ? "📷 Turn Off Camera" : "📷 Turn On Camera"}
        </button>
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
