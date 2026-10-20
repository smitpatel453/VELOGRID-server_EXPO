// Socket Manager: room join/leave, telemetry relay, and ping broadcasts
const roomStore = require('./roomStore');

function initSocketManager(io) {
  io.on('connection', (socket) => {
    console.log(`[Socket Connected] ID: ${socket.id}`);

    /**
     * 1. Join or Create a Convoy Room
     * Payload: { roomCode?: string, riderId: string, riderName: string, color?: string, lat?: number, lng?: number, speed?: number, heading?: number }
     */
    socket.on('join_room', (payload, callback) => {
      try {
        const { roomCode, riderId, riderName, color, lat, lng, speed, heading } = payload || {};
        if (!riderId) {
          if (callback) callback({ success: false, error: 'riderId is required' });
          return;
        }

        const { roomCode: finalCode, roomState } = roomStore.joinRoom(
          roomCode,
          { id: riderId, name: riderName, color, lat, lng, speed, heading },
          socket.id
        );

        // Join socket room
        socket.join(finalCode);
        console.log(`[Room Joined] Rider '${riderName}' (${riderId}) joined room '${finalCode}'`);

        // Broadcast updated room state to all riders in the room
        io.to(finalCode).emit('room_state', roomState);

        // Notify others that a rider joined
        socket.to(finalCode).emit('rider_joined', {
          riderId,
          riderName: riderName || 'A new rider',
          color,
          timestamp: Date.now(),
        });

        if (callback) {
          callback({ success: true, roomCode: finalCode, roomState });
        }
      } catch (err) {
        console.error('[Error in join_room]:', err);
        if (callback) callback({ success: false, error: err.message });
      }
    });

    /**
     * 1B. Fetch Current Room State
     * Payload: { roomCode: string }
     */
    socket.on('get_room_state', (payload, callback) => {
      try {
        const code = payload?.roomCode?.toUpperCase().trim();
        if (!code) return;
        const state = roomStore.getRoomState(code);
        if (state) {
          socket.emit('room_state', state);
          if (callback) callback({ success: true, roomState: state });
        } else {
          if (callback) callback({ success: false, error: 'Room not found' });
        }
      } catch (err) {
        console.error('[Error in get_room_state]:', err);
      }
    });

    /**
     * 2. Real-time Telemetry Update
     * Volatile emit for fast, zero-buffer telemetry broadcast over 4G/5G/2G
     * Payload: { roomCode: string, riderId: string, lat: number, lng: number, speed: number, heading: number, timestamp?: number }
     */
    socket.on('telemetry_update', (payload) => {
      try {
        const { roomCode, riderId, lat, lng, speed, heading, timestamp } = payload || {};
        if (!roomCode || !riderId) return;

        const updatedRider = roomStore.updateTelemetry(roomCode, riderId, {
          lat,
          lng,
          speed,
          heading,
          timestamp: timestamp || Date.now(),
        });

        if (updatedRider) {
          // Volatile emit drops old packets under network congestion for real-time fidelity
          socket.to(roomCode.toUpperCase().trim()).volatile.emit('rider_moved', {
            riderId,
            lat: updatedRider.lat,
            lng: updatedRider.lng,
            speed: updatedRider.speed,
            heading: updatedRider.heading,
            timestamp: updatedRider.lastActive,
          });
        }
      } catch (err) {
        console.error('[Error in telemetry_update]:', err);
      }
    });

    /**
     * 3. Send Tactile / Voice Ping Alert
     * Payload: { roomCode: string, riderId: string, riderName: string, type: 'FUEL' | 'HAZARD' | 'REGROUP' | 'SOS', lat?: number, lng?: number, message?: string }
     */
    socket.on('send_ping', (payload, callback) => {
      try {
        const { roomCode, riderId, riderName, type, lat, lng, message } = payload || {};
        if (!roomCode || !type) {
          if (callback) callback({ success: false, error: 'roomCode and type are required' });
          return;
        }

        const validTypes = ['FUEL', 'HAZARD', 'REGROUP', 'SOS'];
        if (!validTypes.includes(type)) {
          if (callback) callback({ success: false, error: `Invalid ping type: ${type}` });
          return;
        }

        const pingData = {
          id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          roomCode: roomCode.toUpperCase().trim(),
          riderId,
          riderName: riderName || 'Rider',
          type,
          lat,
          lng,
          message: message || '',
          timestamp: Date.now(),
        };

        // Record in store
        roomStore.recordPing(roomCode, riderId, pingData);

        console.log(`[Ping Broadcast] ${type} from ${riderName} in ${roomCode}`);

        // Guaranteed delivery (non-volatile) broadcast to all participants in the room
        io.to(pingData.roomCode).emit('receive_ping', pingData);

        if (callback) callback({ success: true, ping: pingData });
      } catch (err) {
        console.error('[Error in send_ping]:', err);
        if (callback) callback({ success: false, error: err.message });
      }
    });

    /**
     * 4. Explicit Leave Room (User taps EXIT button in HUD)
     * Payload: { roomCode: string, riderId: string }
     */
    socket.on('leave_room', (payload) => {
      try {
        const { roomCode, riderId } = payload || {};
        handleExplicitLeave(socket, roomCode, riderId);
      } catch (err) {
        console.error('[Error in leave_room]:', err);
      }
    });

    /**
     * 5. Disconnect handling (Temporary: app closed, minimized, phone call, network handoff)
     * Keeps room and rider slot alive for 10-minute grace period so reopening resumes instantly!
     */
    socket.on('disconnect', () => {
      console.log(`[Socket Disconnected] ID: ${socket.id} (entering 10-minute reconnect grace period)`);
      roomStore.handleSocketDisconnect(socket.id);
    });
  });

  function handleExplicitLeave(socket, roomCode, riderId) {
    let result = null;
    if (roomCode && riderId) {
      result = roomStore.removeRiderExplicit(roomCode, riderId);
    } else {
      result = roomStore.removeRiderBySocket(socket.id);
    }
    if (!result) return;

    const { roomCode: finalCode, riderId: finalRiderId, riderName, isRoomEmpty } = result;
    socket.leave(finalCode);

    if (isRoomEmpty) {
      console.log(`[Room Cleaned] Room ${finalCode} is now empty and removed.`);
    } else {
      console.log(`[Rider Left] ${riderName} (${finalRiderId}) left room ${finalCode}`);
      // Notify remaining riders
      socket.to(finalCode).emit('rider_left', {
        riderId: finalRiderId,
        riderName,
        timestamp: Date.now(),
      });

      // Send refreshed room state
      const updatedState = roomStore.getRoomState(finalCode);
      if (updatedState) {
        io.to(finalCode).emit('room_state', updatedState);
      }
    }
  }
}

module.exports = { initSocketManager };
