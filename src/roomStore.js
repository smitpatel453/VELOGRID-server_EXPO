// In-memory active convoy state store for VeloGrid real-time radar

class RoomStore {
  constructor() {
    // Key: roomCode (e.g., "GRID89"), Value: Room object
    this.rooms = new Map();
    // Key: socketId, Value: { roomCode, riderId }
    this.socketMap = new Map();
  }

  // Generate a random 6-character alphanumeric room code
  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous chars 0/O, 1/I
    let code = '';
    do {
      code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    } while (this.rooms.has(code));
    return code;
  }

  /**
   * Check if an active convoy room exists
   * @param {string} roomCode
   */
  hasRoom(roomCode) {
    if (!roomCode) return false;
    return this.rooms.has(roomCode.toUpperCase().trim());
  }

  /**
   * Adds or registers a rider in a room (preserves membership on reconnects!)
   * @param {string} roomCode 
   * @param {Object} rider 
   * @param {string} socketId 
   * @param {boolean} isCreating
   */
  joinRoom(roomCode, rider, socketId, isCreating = false) {
    let code = roomCode ? roomCode.toUpperCase().trim() : '';

    if (!isCreating && code) {
      if (!this.rooms.has(code)) {
        throw new Error(`Enter a valid join code. Convoy room '${code}' does not exist.`);
      }
    } else {
      // Creating a new convoy
      if (!code || this.rooms.has(code)) {
        code = this.generateRoomCode();
      }
    }

    if (!this.rooms.has(code)) {
      this.rooms.set(code, {
        code,
        hostId: rider.id,
        createdAt: Date.now(),
        riders: new Map(),
      });
    }

    const room = this.rooms.get(code);

    // Cancel any pending disconnect timer if this rider was temporarily disconnected
    const existing = room.riders.get(rider.id);
    if (existing && existing.disconnectTimer) {
      clearTimeout(existing.disconnectTimer);
      existing.disconnectTimer = null;
    }

    // Preserve coordinates on reconnect unless fresh coordinates are supplied
    let initialLat = typeof rider.lat === 'number' && rider.lat !== 0 ? rider.lat : (existing?.lat || 0);
    let initialLng = typeof rider.lng === 'number' && rider.lng !== 0 ? rider.lng : (existing?.lng || 0);
    if ((!initialLat || !initialLng) && room.riders.size > 0) {
      for (const existingRider of room.riders.values()) {
        if (existingRider.id !== rider.id && existingRider.lat && existingRider.lng) {
          initialLat = existingRider.lat + 0.0003; // ~35 meters offset
          initialLng = existingRider.lng + 0.0003;
          break;
        }
      }
    }

    const riderData = {
      id: rider.id,
      name: rider.name || existing?.name || `Rider-${rider.id.slice(0, 4)}`,
      color: rider.color || existing?.color || '#00F5D4',
      socketId,
      lat: initialLat,
      lng: initialLng,
      speed: typeof rider.speed === 'number' ? rider.speed : (existing?.speed || 0),
      heading: typeof rider.heading === 'number' ? rider.heading : (existing?.heading || 0),
      lastActive: Date.now(),
      lastPing: existing?.lastPing || null,
      isDisconnected: false,
      disconnectTimer: null,
    };

    room.riders.set(rider.id, riderData);
    this.socketMap.set(socketId, { roomCode: code, riderId: rider.id });

    return { roomCode: code, roomState: this.getRoomState(code) };
  }

  /**
   * Explicit leave: Rider actively taps EXIT button in HUD
   */
  removeRiderExplicit(roomCode, riderId) {
    const code = roomCode?.toUpperCase().trim();
    const room = this.rooms.get(code);
    if (!room) return null;

    const rider = room.riders.get(riderId);
    if (rider && rider.disconnectTimer) {
      clearTimeout(rider.disconnectTimer);
    }
    if (rider && rider.socketId) {
      this.socketMap.delete(rider.socketId);
    }
    room.riders.delete(riderId);

    let newHostId = room.hostId;
    if (room.hostId === riderId && room.riders.size > 0) {
      newHostId = room.riders.keys().next().value;
      room.hostId = newHostId;
    }

    const isRoomEmpty = room.riders.size === 0;
    if (isRoomEmpty) {
      this.rooms.delete(code);
    }

    return {
      roomCode: code,
      riderId,
      riderName: rider?.name || 'Rider',
      isRoomEmpty,
      newHostId,
      remainingCount: room.riders.size,
    };
  }

  /**
   * Update rider's real-time telemetry (lat, lng, speed, heading)
   */
  updateTelemetry(roomCode, riderId, telemetry) {
    const code = roomCode?.toUpperCase().trim();
    const room = this.rooms.get(code);
    if (!room) return null;

    const rider = room.riders.get(riderId);
    if (!rider) return null;

    rider.lat = typeof telemetry.lat === 'number' ? telemetry.lat : rider.lat;
    rider.lng = typeof telemetry.lng === 'number' ? telemetry.lng : rider.lng;
    rider.speed = typeof telemetry.speed === 'number' ? telemetry.speed : rider.speed;
    rider.heading = typeof telemetry.heading === 'number' ? telemetry.heading : rider.heading;
    rider.lastActive = telemetry.timestamp || Date.now();

    return rider;
  }

  /**
   * Record a ping from a rider (FUEL, HAZARD, REGROUP, SOS)
   */
  recordPing(roomCode, riderId, ping) {
    const code = roomCode?.toUpperCase().trim();
    const room = this.rooms.get(code);
    if (!room) return null;

    const rider = room.riders.get(riderId);
    if (!rider) return null;

    const pingRecord = {
      type: ping.type,
      timestamp: ping.timestamp || Date.now(),
      lat: ping.lat ?? rider.lat,
      lng: ping.lng ?? rider.lng,
      message: ping.message || '',
    };

    rider.lastPing = pingRecord;
    return { rider, pingRecord };
  }

  /**
   * Temporary socket disconnect (app closed, phone call, network drop)
   * Gives a 10-minute grace period to preserve room and rider membership!
   */
  handleSocketDisconnect(socketId) {
    const mapping = this.socketMap.get(socketId);
    if (!mapping) return null;

    const { roomCode, riderId } = mapping;
    this.socketMap.delete(socketId);

    const room = this.rooms.get(roomCode);
    if (!room) return null;

    const rider = room.riders.get(riderId);
    if (!rider) return null;

    rider.isDisconnected = true;
    rider.socketId = null;

    // Grace period timer: 10 minutes
    if (rider.disconnectTimer) {
      clearTimeout(rider.disconnectTimer);
    }
    rider.disconnectTimer = setTimeout(() => {
      console.log(`[Grace Period Expired] Purging rider ${rider.name} (${riderId}) from room ${roomCode}`);
      this.removeRiderExplicit(roomCode, riderId);
    }, 10 * 60 * 1000);

    return {
      roomCode,
      riderId,
      riderName: rider.name,
      isTemporary: true,
    };
  }

  /**
   * Remove rider by their socket ID (fallback)
   */
  removeRiderBySocket(socketId) {
    const mapping = this.socketMap.get(socketId);
    if (!mapping) return null;

    const { roomCode, riderId } = mapping;
    return this.removeRiderExplicit(roomCode, riderId);
  }

  /**
   * Get sanitized, JSON-serializable state of a room
   */
  getRoomState(roomCode) {
    const code = roomCode.toUpperCase().trim();
    const room = this.rooms.get(code);
    if (!room) return null;

    const ridersArray = Array.from(room.riders.values()).map(r => ({
      id: r.id,
      name: r.name,
      color: r.color,
      lat: r.lat,
      lng: r.lng,
      speed: r.speed,
      heading: r.heading,
      lastActive: r.lastActive,
      lastPing: r.lastPing,
    }));

    return {
      roomCode: room.code,
      hostId: room.hostId,
      createdAt: room.createdAt,
      riders: ridersArray,
    };
  }

  /**
   * Get total active counts
   */
  getStats() {
    return {
      activeRooms: this.rooms.size,
      activeRiders: this.socketMap.size,
    };
  }
}

module.exports = new RoomStore();
