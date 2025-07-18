'use client';

import { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';

const App = () => {
  const [socket, setSocket] = useState(null);
  const [isMatched, setIsMatched] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [loading, setLoading] = useState(false);

  const peerConnectionRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const pendingCandidatesRef = useRef([]);

  useEffect(() => {
    const newSocket = io('https://omegle-v3gr.onrender.com');
    setSocket(newSocket);

    newSocket.on('match-found', () => {
      console.log('Match found!');
      setIsMatched(true);
      startVideoChat();
    });

    newSocket.on('offer', async (offer) => {
      console.log('Received offer');
      await startVideoChat();

      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(offer));

      // Process pending ICE candidates
      processPendingCandidates();

      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);

      newSocket.emit('answer', answer);
    });

    newSocket.on('answer', async (answer) => {
      console.log('Received answer');
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));

      // Process pending ICE candidates
      processPendingCandidates();
    });

    newSocket.on('ice-candidate', async (candidate) => {
      if (peerConnectionRef.current && peerConnectionRef.current.remoteDescription) {
        try {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
          console.error('Error adding ICE candidate:', error);
        }
      } else {
        pendingCandidatesRef.current.push(candidate);
      }
    });

    newSocket.on('partner-left', () => {
      console.log('Partner left');
      endVideoChat();
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  const processPendingCandidates = async () => {
    for (const candidate of pendingCandidatesRef.current) {
      try {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('Pending candidate error:', err);
      }
    }
    pendingCandidatesRef.current = [];
  };

  const startVideoChat = async () => {
    // Clean up previous connection
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    setLocalStream(stream);

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }

    const peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        {
          urls: 'turn:relay1.expressturn.com:3478',
          username: 'ef8c808c3db4c6c97bfb51b1',
          credential: 'L12RMXlKw3Tf0Bzu',
        },
      ],
    });

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', event.candidate);
      }
    };

    peerConnection.ontrack = (event) => {
      console.log('Received remote track');
      setRemoteStream(event.streams[0]);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      console.log('ICE state:', peerConnection.iceConnectionState);
    };

    stream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, stream);
    });

    peerConnectionRef.current = peerConnection;

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('offer', offer);
  };

  const endVideoChat = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      setLocalStream(null);
    }

    if (remoteStream) {
      remoteStream.getTracks().forEach((track) => track.stop());
      setRemoteStream(null);
    }

    setIsMatched(false);
    pendingCandidatesRef.current = [];
  };

  const handleSkip = () => {
    endVideoChat();
    socket.emit('skip');
  };

  const handleStart = () => {
    setLoading(true);
    socket.emit('join-room');
  };

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  return (
    <div>
      <h1>Omegle Video Chat</h1>
      {!isMatched && !loading && <button onClick={handleStart}>Start</button>}
      {loading && !isMatched && <p>Looking for a partner...</p>}
      {isMatched && <button onClick={handleSkip}>Skip</button>}

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '20px' }}>
        <div style={{ margin: '0 10px' }}>
          <h3>You</h3>
          <video ref={localVideoRef} autoPlay playsInline muted width="300" height="225" />
        </div>
        <div style={{ margin: '0 10px' }}>
          <h3>Stranger</h3>
          <video ref={remoteVideoRef} autoPlay playsInline width="300" height="225" />
        </div>
      </div>
    </div>
  );
};

export default App;
