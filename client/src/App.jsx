/*
Corrected frontend files (App.jsx + socket.js) combined in one document for easy copy.

Files included below:
- src/socket.js      -> stable socket.io client wrapper (uses VITE_API_URL)
- src/App.jsx        -> robust React component with WebRTC signaling, queuing, toggles and cleanup

HOW TO USE
1. Put socket.js into src/socket.js
2. Replace your src/App.jsx with the App.jsx section below
3. Ensure .env has VITE_API_URL = "https://your-backend.example.com" (or http://localhost:3000 for local)
4. Run `npm run dev` for Vite frontend, and make sure backend is running and accessible.

NOTES
- This code queues emits until socket connects.
- Signaling payloads are objects { sdp } and { candidate } to match typical server forwarding.
- ICE candidates are queued on the client until remoteDescription is available.
- Audio/video toggles now replace senders' tracks where supported so muted streams are not transmitted.
- Cleanup uses socket.off for each handler instead of removeAllListeners.
*/


// =========================
// src/App.jsx
// =========================
import { useEffect, useState, useRef } from 'react';
import socket from './socket';
import './App.css';

export default function App() {
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const iceCandidatesQueue = useRef([]);
  const audioSenderRef = useRef(null);
  const videoSenderRef = useRef(null);

  const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [statusMessage, setStatusMessage] = useState('Looking for a partner...');

  // Apply queued ICE candidates once remoteDescription is set
  const applyQueuedCandidates = async () => {
    if (!peerConnectionRef.current) return;
    for (const c of iceCandidatesQueue.current) {
      try {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(c));
      } catch (err) {
        console.warn('applyQueuedCandidates error', err);
      }
    }
    iceCandidatesQueue.current = [];
  };

  const startVideoChat = async () => {
    // avoid re-creating
    if (peerConnectionRef.current) return;

    // request permissions and get media
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideoRef.current.srcObject = stream;
    localStreamRef.current = stream;

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnectionRef.current = pc;

    // add tracks and keep senders so we can replace tracks when toggling
    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream);
      if (track.kind === 'audio') audioSenderRef.current = sender;
      if (track.kind === 'video') videoSenderRef.current = sender;
    }

    // remote stream handling
    pc.ontrack = (ev) => {
      // usually streams[0] contains remote MediaStream
      remoteVideoRef.current.srcObject = ev.streams[0] || ev.streams && ev.streams[0];
    };

    // ICE candidates -> server
    pc.onicecandidate = (ev) => {
      if (ev.candidate) socket.emit('webrtc_ice_candidate', { candidate: ev.candidate });
    };

    // optional: handle connection state changes for better UX
    pc.onconnectionstatechange = () => {
      console.info('pc state', pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        // attempt cleanup
        // don't automatically rematch here — server will notify peer_disconnected when appropriate
      }
    };

    return pc;
  };

  const toggleMic = async () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;

    // flip local track enabled state
    audioTrack.enabled = !audioTrack.enabled;
    setMicEnabled(audioTrack.enabled);

    // replace sender track so remote receives silence if browser supports replaceTrack
    try {
      if (audioSenderRef.current) {
        // when muted we can replace with null (some browsers accept null), else replace with actual track
        await audioSenderRef.current.replaceTrack(audioTrack.enabled ? audioTrack : null);
      }
    } catch (err) {
      console.warn('replaceTrack audio failed', err);
    }
  };

  const toggleCamera = async () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    videoTrack.enabled = !videoTrack.enabled;
    setCameraEnabled(videoTrack.enabled);

    try {
      if (videoSenderRef.current) {
        await videoSenderRef.current.replaceTrack(videoTrack.enabled ? videoTrack : null);
      }
    } catch (err) {
      console.warn('replaceTrack video failed', err);
    }
  };

  useEffect(() => {
    // connect socket
    socket.connect();

    // Handler functions (named so we can .off them later)
    const onMatchFound = async ({ roomId, peerIP }) => {
      setWaiting(false);
      setConnected(true);
      setMessages([]);
      setStatusMessage('✅ Connected! Say hi 👋');

      await startVideoChat();
      const offer = await peerConnectionRef.current.createOffer();
      await peerConnectionRef.current.setLocalDescription(offer);
      socket.emit('webrtc_offer', { sdp: offer });
    };

    const onOffer = async ({ sdp, from }) => {
      await startVideoChat();
      // set remote description
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
      socket.emit('webrtc_answer', { sdp: answer });
      await applyQueuedCandidates();
    };

    const onAnswer = async ({ sdp }) => {
      // only set if we've created a local offer previously
      try {
        if (peerConnectionRef.current && peerConnectionRef.current.signalingState === 'have-local-offer') {
          await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
          await applyQueuedCandidates();
        } else {
          console.warn('Ignoring answer — not in have-local-offer state');
        }
      } catch (err) {
        console.warn('setRemoteDescription(answer) failed', err);
      }
    };

    const onIceCandidate = async ({ candidate }) => {
      try {
        if (!candidate || !candidate.candidate) return;
        if (peerConnectionRef.current?.remoteDescription?.type) {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          iceCandidatesQueue.current.push(candidate);
        }
      } catch (err) {
        console.warn('onIceCandidate error', err);
      }
    };

    const onMessage = (data) => setMessages((p) => [...p, { sender: 'stranger', text: data }]);

    const onPeerDisconnected = () => {
      setConnected(false);
      setWaiting(true);
      setStatusMessage('❌ Partner disconnected. Looking for a new one...');
      setMessages((p) => [...p, { sender: 'system', text: 'Partner disconnected.' }]);

      peerConnectionRef.current?.close();
      peerConnectionRef.current = null;

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }

      localVideoRef.current.srcObject = null;
      remoteVideoRef.current.srcObject = null;

      // re-request a match
      socket.emit('find_match');
    };

    const onWaiting = () => {
      setWaiting(true);
      setStatusMessage('🕒 Waiting for a partner...');
    };

    // register
    socket.on('match_found', onMatchFound);
    socket.on('webrtc_offer', onOffer);
    socket.on('webrtc_answer', onAnswer);
    socket.on('webrtc_ice_candidate', onIceCandidate);
    socket.on('message', onMessage);
    socket.on('peer_disconnected', onPeerDisconnected);
    socket.on('waiting', onWaiting);

    // request matchmaking (safeEmit queues if not connected yet)
    socket.emit('find_match');

    return () => {
      // cleanup listeners and close pc
      socket.off('match_found', onMatchFound);
      socket.off('webrtc_offer', onOffer);
      socket.off('webrtc_answer', onAnswer);
      socket.off('webrtc_ice_candidate', onIceCandidate);
      socket.off('message', onMessage);
      socket.off('peer_disconnected', onPeerDisconnected);
      socket.off('waiting', onWaiting);

      try {
        socket.disconnect();
      } catch (e) {
        // already disconnected
      }

      peerConnectionRef.current?.close();
    };
  }, []);

  const sendMessage = () => {
    if (!input.trim()) return;
    socket.emit('message', input);
    setMessages((p) => [...p, { sender: 'me', text: input }]);
    setInput('');
  };

  const handleSkip = () => {
    // close peer, stop local devices
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }

    localVideoRef.current.srcObject = null;
    remoteVideoRef.current.srcObject = null;

    socket.emit('skip');
    setMessages([]);
    setConnected(false);
    setWaiting(true);
    setStatusMessage('⏩ Skipped! Searching for a new partner...');
    socket.emit('find_match');
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
        <button onClick={toggleMic}>{micEnabled ? '🎤 Mute Mic' : '🔇 Unmute Mic'}</button>
        <button onClick={toggleCamera}>{cameraEnabled ? '📷 Turn Off Camera' : '📷 Turn On Camera'}</button>
        {connected && <button className="skip-btn" onClick={handleSkip}>⏩ Skip</button>}
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
        <button onClick={sendMessage} disabled={!connected}>Send</button>
      </div>
    </div>
  );
}
