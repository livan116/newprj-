import React, { createContext, useContext, useRef, useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext';

const ChatContext = createContext();
export const useChat = () => useContext(ChatContext);

export const ChatProvider = ({ children }) => {
  const { user } = useAuth();
  const socketRef = useRef(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMatched, setIsMatched] = useState(false);
  const [matchDetails, setMatchDetails] = useState(null);
  const [peerConnection, setPeerConnection] = useState(null);
  const callStartedRef = useRef(false);
  const pendingCandidates = useRef([]);

  const iceServers = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      {
        urls: 'turn:relay1.expressturn.com:3480',
        username: '174672462322246224',
        credential: 'wPWy5/Q8xaF3LVOKZOdExrhnZ+4='
      }
    ],
  };

  const initializeSocket = (gender, interest, name, mode) => {
    if (socketRef.current) return socketRef.current;

    const socketInstance = window.socket || io(
      process.env.NODE_ENV === 'production'
        ? 'https://buzzy-server-nu.vercel.app'
        : 'http://localhost:3000',
      {
        transports: ['websocket'],
        withCredentials: true,
      }
    );

    if (!window.socket) {
      window.socket = socketInstance;
    }

    socketRef.current = socketInstance;

    socketInstance.on('connect', () => {
      console.log('Socket connected:', socketInstance.id);
      socketInstance.emit('user-details', { gender, interest, name, mode });
      setIsConnecting(true);
    });

    socketInstance.on('find other', () => {
      cleanupMatch();
      setIsConnecting(true);  
      if (user) {
        socketInstance.emit('user-details', {
          gender: user.gender,
          interest: user.interest,
          mode
        });
      }
    });

    socketInstance.on('match-found', (data) => {
      if (data.matched) {
        setIsMatched(true);
        setIsConnecting(false);
        setMatchDetails({ partnerId: data.socketId });
        console.log("Matched with:", data.socketId);
      }
    });

    socketInstance.on("cleanup", () => {
      setIsConnecting(true);
      cleanupMatch();
    });

    return socketInstance;
  };

  const disconnectSocket = () => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
      window.socket = null;
    }
    cleanupMatch();
  };

  const cleanupMatch = () => {
    setIsMatched(false);
    setMatchDetails(null);
    if (peerConnection) {
      peerConnection.close();
      setPeerConnection(null);
    }
    callStartedRef.current = false;
    pendingCandidates.current = [];
  };

  const disconnectFromMatch = (mode) => {
    const socket = socketRef.current;
    if (socket && matchDetails) {
      socket.emit('disconnect-chat', matchDetails.partnerId, mode);
      cleanupMatch();
    }
  };

  const next = (mode) => {
    const socket = socketRef.current;
    if (socket && matchDetails) {
      socket.emit('next', matchDetails.partnerId, mode);
    } 
    cleanupMatch();
  }; 

  const sendMessage = (message, partnerId) => {
    const socket = socketRef.current;
    if (socket && partnerId) {
      socket.emit('send-message', message, partnerId);
    }
  };

  const startVideoCall = async (partnerId, localStream, remoteVideoElement) => {
    if (callStartedRef.current || !partnerId || !localStream) return;
    
    const socket = socketRef.current;
    if (!socket) return;

    try {
      // Close existing connection if any
      if (peerConnection) {
        peerConnection.close();
      }

      const pc = new RTCPeerConnection(iceServers);
      setPeerConnection(pc);

      // Add local tracks
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("ice-candidate", event.candidate, partnerId);
        }
      };

      // Handle incoming tracks
      pc.ontrack = (event) => {
        if (remoteVideoElement && event.streams[0]) {
          remoteVideoElement.srcObject = event.streams[0];
        }
      };

      // Clean up existing listeners
      socket.removeAllListeners("video-offer");
      socket.removeAllListeners("video-answer");
      socket.removeAllListeners("ice-candidate");
      socket.removeAllListeners("end-video");

      // Handle video offer
      socket.on("video-offer", async (offer, fromSocketId) => {
        if (partnerId !== fromSocketId) return;
        
        try {
          if (pc.signalingState !== "stable") {
            await Promise.all([
              pc.setLocalDescription({type: "rollback"}),
              pc.setRemoteDescription(new RTCSessionDescription(offer))
            ]);
          } else {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
          }
          
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("video-answer", answer, fromSocketId);
        } catch (error) {
          console.error("Error handling offer:", error);
        }
      });

      // Handle video answer
      socket.on("video-answer", async (answer) => {
        try {
          if (pc.signalingState === "have-local-offer") {
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
            // Apply any pending ICE candidates
            while (pendingCandidates.current.length) {
              const candidate = pendingCandidates.current.shift();
              await pc.addIceCandidate(candidate);
            }
          }
        } catch (error) {
          console.error("Error applying answer:", error);
        }
      });

      // Handle ICE candidates
      socket.on("ice-candidate", async (candidate) => {
        try {
          const iceCandidate = new RTCIceCandidate(candidate);
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(iceCandidate);
          } else {
            pendingCandidates.current.push(iceCandidate);
          }
        } catch (error) {
          console.error("Error adding ICE candidate:", error);
        }
      });

      // Handle call end
      socket.on("end-video", () => {
        cleanupMatch();
      });

      // Create and send offer
      callStartedRef.current = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("video-offer", offer, partnerId);

    } catch (error) {
      console.error('Error starting video call:', error);
      cleanupMatch();
    }
  };

  const endVideoCall = () => {
    const socket = socketRef.current;
    if (socket && matchDetails) {
      socket.emit("end-video", matchDetails.partnerId);
    }
    cleanupMatch();
  };

  const value = {
    socket: socketRef.current,
    isConnecting,
    isMatched,
    matchDetails,
    initializeSocket,
    disconnectSocket,
    disconnectFromMatch,
    next,
    setIsConnecting,
    sendMessage,
    startVideoCall,
    endVideoCall,
  };

  return (
    <ChatContext.Provider value={value}>
      {children}
    </ChatContext.Provider>
  );
};