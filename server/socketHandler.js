const textwaitingUsers = new Map();  
const videowaitingUsers = new Map();
const activePairs = new Map();
const activeVideoCalls = new Set();
const pastSocketsMap = new Map();
const SOCKET_RETENTION_TIME = 3 * 60 * 1000; // 3 minutes

export default (io, socket) => {
  socket.on('user-details', ({ gender, interest, name, mode}) => { 
    if(mode === "text") {
      socket.data = { gender, interest };
      console.log(`User ${socket.id} joined with gender: ${gender}, interest: ${interest} for chat`);
      cleanupUserConnections(socket.id); 
      
      for (let [id, otherSocket] of textwaitingUsers) {
        if (id === socket.id) continue;
        
        // Check if users haven't chatted recently
        if (hasPastConnection(socket.id, id)) continue;
        
        if (
          otherSocket.data &&
          otherSocket.data.gender === interest &&
          otherSocket.data.interest === gender  
        ) {
          console.log("user deleted from waiting list: ", id);
          textwaitingUsers.delete(id); 
          
          const matchedSocket = io.sockets.sockets.get(id);
          if (matchedSocket) {
            matchedSocket.emit('match-found', { matched: true, socketId: socket.id });
            socket.emit('match-found', { matched: true, socketId: matchedSocket.id });
            activePairs.set(socket.id, matchedSocket.id);
            activePairs.set(matchedSocket.id, socket.id); 
            
            // Add to past connections
            addPastConnection(socket.id, matchedSocket.id);
            addPastConnection(matchedSocket.id, socket.id);
            
            console.log(`🎯 Match found: ${socket.id} <--> ${matchedSocket.id}`);
          }
          return;
        }
      }
      textwaitingUsers.set(socket.id, socket);
      console.log(`User ${socket.id} added to waiting list.`); 
    } 
    else { 
      socket.data = { gender, interest };
      console.log(`User ${socket.id} joined with gender: ${gender}, interest: ${interest} for video`);
      cleanupUserConnections(socket.id); 
      
      for (let [id, otherSocket] of videowaitingUsers) {
        if (id === socket.id) continue;
        
        // Check if users haven't chatted recently
        if (hasPastConnection(socket.id, id)) continue;
        
        if (
          otherSocket.data &&
          otherSocket.data.gender === interest &&
          otherSocket.data.interest === gender  
        ) {
          console.log("user deleted from waiting list: ", id);
          videowaitingUsers.delete(id); 
          
          const matchedSocket = io.sockets.sockets.get(id);
          if (matchedSocket) {
            matchedSocket.emit('match-found', { matched: true, socketId: socket.id });
            socket.emit('match-found', { matched: true, socketId: matchedSocket.id });
            activePairs.set(socket.id, matchedSocket.id);
            activePairs.set(matchedSocket.id, socket.id); 
            activeVideoCalls.add(`${socket.id}-${matchedSocket.id}`);
            activeVideoCalls.add(`${matchedSocket.id}-${socket.id}`);
            
            // Add to past connections
            addPastConnection(socket.id, matchedSocket.id);
            addPastConnection(matchedSocket.id, socket.id);
            
            console.log(`🎯 Match found: ${socket.id} <--> ${matchedSocket.id}`);
          }
          return;
        }
      }
      videowaitingUsers.set(socket.id, socket);
      console.log(`User ${socket.id} added to waiting list.`); 
    }
  });

  socket.on('send-message', (message, toSocketId) => {
    const target = io.sockets.sockets.get(toSocketId);
    if (target) {
      target.emit('receive-message', message);
    }
  });

  socket.on('disconnect-chat', (partnerSocketId, mode) => { 
    console.log(mode);
    const partnerSocket = io.sockets.sockets.get(partnerSocketId); 
    
    if (mode === "video") {
      if (activeVideoCalls.has(`${socket.id}-${partnerSocketId}`) ||
          activeVideoCalls.has(`${partnerSocketId}-${socket.id}`)) {
        handleVideoCallEnd(socket.id, partnerSocketId);   
        socket.emit("end-video"); 
        if (partnerSocket) {
          partnerSocket.emit("end-video");
        }
      }

      console.log("users will be added to the videoqueue")
      if (partnerSocket) { 
        partnerSocket.emit("find other");
      }
      
      activePairs.delete(socket.id);
      activePairs.delete(partnerSocketId);
    } 
    else { 
      if (partnerSocket) {
        partnerSocket.emit('disconect', "Partner disconnected.");
      }
      socket.emit('disconect', "You disconnected.");
      console.log("users will be added to the textqueue")
      if (partnerSocket) {
        partnerSocket.emit("find other");
      }
      
      activePairs.delete(socket.id);
      activePairs.delete(partnerSocketId);
    }
  }); 

  socket.on('next', (partnerSocketId, mode) => {
    const partnerSocket = io.sockets.sockets.get(partnerSocketId);
    
    if (mode === "video") {
      if (activeVideoCalls.has(`${socket.id}-${partnerSocketId}`) ||
          activeVideoCalls.has(`${partnerSocketId}-${socket.id}`)) {
        handleVideoCallEnd(socket.id, partnerSocketId); 
      }
    }
    
    if (partnerSocket) {
      partnerSocket.emit("find other");
    }
    socket.emit("find other");
    
    // Cleanup connections
    activePairs.delete(socket.id);
    activePairs.delete(partnerSocketId);
  });

  socket.on('disconnect', () => {
    cleanupUserConnections(socket.id);
  });

  socket.on("video-offer", (offer, toSocketId) => {
    const target = io.sockets.sockets.get(toSocketId);
    if (target) {
      target.emit("video-offer", offer, socket.id);
    }
  });

  socket.on("video-answer", (answer, toSocketId) => {
    const target = io.sockets.sockets.get(toSocketId);
    if (target) {
      target.emit("video-answer", answer);
    }
  });

  socket.on("ice-candidate", (candidate, toSocketId) => {
    const target = io.sockets.sockets.get(toSocketId);
    if (target) {
      console.log(`Forwarding ICE candidate to ${toSocketId}`);
      target.emit("ice-candidate", candidate);
    }
  });

  socket.on("start-call", (partnerId) => {
    activeVideoCalls.add(`${socket.id}-${partnerId}`);
  });

  socket.on("end-call", (partnerId) => {
    handleVideoCallEnd(socket.id, partnerId);
  });

  function cleanupUserConnections(userId) {
    videowaitingUsers.delete(userId); 
    textwaitingUsers.delete(userId);
    
    const partnerId = activePairs.get(userId);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('disconect', "Partner disconnected unexpectedly.");
      }
      activePairs.delete(userId);
      activePairs.delete(partnerId);
    }

    // Cleanup video calls
    activeVideoCalls.forEach(callId => {
      if (callId.includes(userId)) {
        activeVideoCalls.delete(callId);
      }
    });
  }

  function handleVideoCallEnd(userId, partnerId) {
    activeVideoCalls.delete(`${userId}-${partnerId}`);
    activeVideoCalls.delete(`${partnerId}-${userId}`);
    activePairs.delete(userId);
    activePairs.delete(partnerId);
  }

  function addPastConnection(currentSocketId, pastSocketId) {
    if (!pastSocketsMap.has(currentSocketId)) {
      pastSocketsMap.set(currentSocketId, []);
    }
    
    const entry = { id: pastSocketId, timestamp: Date.now() };
    pastSocketsMap.get(currentSocketId).push(entry);
    
    // Cleanup old entries after retention time
    setTimeout(() => {
      const connections = pastSocketsMap.get(currentSocketId);
      if (connections) {
        const updatedConnections = connections.filter(conn => 
          Date.now() - conn.timestamp < SOCKET_RETENTION_TIME
        );
        if (updatedConnections.length > 0) {
          pastSocketsMap.set(currentSocketId, updatedConnections);
        } else {
          pastSocketsMap.delete(currentSocketId);
        }
      }
    }, SOCKET_RETENTION_TIME);
  }

  function hasPastConnection(socketId1, socketId2) {
    const connections1 = pastSocketsMap.get(socketId1);
    const connections2 = pastSocketsMap.get(socketId2);
    
    if (connections1) {
      const recentConnection = connections1.find(conn => 
        conn.id === socketId2 && 
        Date.now() - conn.timestamp < SOCKET_RETENTION_TIME
      );
      if (recentConnection) return true;
    }
    
    if (connections2) {
      const recentConnection = connections2.find(conn => 
        conn.id === socketId1 && 
        Date.now() - conn.timestamp < SOCKET_RETENTION_TIME
      );
      if (recentConnection) return true;
    }
    
    return false;
  }
};