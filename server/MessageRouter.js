/**
 * MessageRouter - Message type identification, routing, and init segment caching.
 *
 * Responsibilities:
 * 1. Identify message type (binary vs JSON)
 * 2. Detect and cache init segments (ftyp+moov) for late-joining viewers
 * 3. Route messages between session participants:
 *    - device binary → viewer
 *    - viewer JSON → controller
 *    - controller → viewer
 *
 * Requirements: 6.4, 6.5, 2.2
 */

// ftyp box magic bytes: ASCII "ftyp" at offset 4
const FTYP_MAGIC = Buffer.from('ftyp', 'ascii');
const FTYP_OFFSET = 4;

class MessageRouter {
  constructor() {
    this.initSegmentCache = new Map();
    // Cache last keyframe media segment for instant display on viewer join
    this.lastKeyframeCache = new Map();
  }

  /**
   * Determine if a message is binary data.
   * @param {*} message - The WebSocket message
   * @returns {boolean}
   */
  isBinary(message) {
    return Buffer.isBuffer(message) || message instanceof ArrayBuffer || message instanceof Uint8Array;
  }

  /**
   * Detect if a binary message is an init segment (starts with ftyp box).
   * An ftyp box has the structure: [4-byte size][4-byte type "ftyp"][...data]
   * We check for the "ftyp" magic bytes at offset 4.
   * @param {Buffer} data - Binary data to check
   * @returns {boolean}
   */
  isInitSegment(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < FTYP_OFFSET + FTYP_MAGIC.length) {
      return false;
    }
    return buf.subarray(FTYP_OFFSET, FTYP_OFFSET + FTYP_MAGIC.length).equals(FTYP_MAGIC);
  }

  /**
   * Cache an init segment for a session.
   * @param {string} sessionId - The session identifier
   * @param {Buffer} data - The init segment data
   */
  cacheInitSegment(sessionId, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.initSegmentCache.set(sessionId, buf);
    console.log(`[MessageRouter] Cached init segment for session ${sessionId} (${buf.length} bytes)`);
  }

  /**
   * Get the cached init segment for a session.
   * @param {string} sessionId - The session identifier
   * @returns {Buffer|null}
   */
  getCachedInitSegment(sessionId) {
    return this.initSegmentCache.get(sessionId) || null;
  }

  /**
   * Remove cached init segment when a session is cleaned up.
   * @param {string} sessionId - The session identifier
   */
  clearInitSegmentCache(sessionId) {
    if (this.initSegmentCache.delete(sessionId)) {
      console.log(`[MessageRouter] Cleared init segment cache for session ${sessionId}`);
    }
    this.lastKeyframeCache.delete(sessionId);
  }

  /**
   * Send the cached init segment to a viewer that connected after the device
   * already started streaming.
   * @param {string} sessionId - The session identifier
   * @param {WebSocket} viewerWs - The viewer WebSocket connection
   * @returns {boolean} Whether an init segment was sent
   */
  replayInitSegment(sessionId, viewerWs) {
    const initSegment = this.getCachedInitSegment(sessionId);
    if (initSegment && viewerWs && viewerWs.readyState === 1) {
      viewerWs.send(initSegment);
      console.log(`[MessageRouter] Replayed init segment to viewer for session ${sessionId}`);
      return true;
    }
    return false;
  }

  /**
   * Route a message from a WebSocket to the appropriate target(s) in the same session.
   *
   * Routing rules:
   * - device binary messages (fMP4 segments) → forward to viewer
   *   - If the binary message is an init segment, cache it
   * - viewer JSON messages → forward to controller
   * - controller messages → forward to viewer (status feedback)
   *
   * @param {WebSocket} ws - The sender WebSocket
   * @param {*} message - The message data
   * @param {string} role - The sender's role ('device', 'viewer', 'controller')
   * @param {object} session - The session object containing device, viewer, controller WebSockets
   * @returns {boolean} Whether the message was successfully routed
   */
  route(ws, message, role, session) {
    if (!session) {
      console.log('[MessageRouter] No session provided for routing');
      return false;
    }

    if (role === 'device') {
      return this._routeDeviceMessage(message, session);
    } else if (role === 'viewer') {
      return this._routeViewerMessage(message, session);
    } else if (role === 'controller') {
      return this._routeControllerMessage(message, session);
    }

    return false;
  }

  /**
   * Route a message from the device.
   * Binary messages (fMP4 segments) are forwarded to the viewer.
   * Init segments are cached for late-joining viewers.
   * @private
   */
  _routeDeviceMessage(message, session) {
    if (this.isBinary(message)) {
      if (this.isInitSegment(message)) {
        this.cacheInitSegment(session.sessionId, message);
      } else {
        // Not init segment, just forward
      }

      // Forward binary data to ALL viewers
      let sent = false;
      for (const viewer of (session.viewers || [])) {
        if (viewer && viewer.readyState === 1) {
          viewer.send(message);
          sent = true;
        }
      }
      return sent;
    }
    return false;
  }

  /**
   * Route a message from the viewer.
   * JSON messages (Control_Commands) are forwarded to the controller.
   * @private
   */
  _routeViewerMessage(message, session) {
    if (session.controller && session.controller.readyState === 1) {
      session.controller.send(message);
      return true;
    }
    return false;
  }

  /**
   * Route a message from the controller.
   * Status feedback messages are forwarded to the viewer.
   * @private
   */
  _routeControllerMessage(message, session) {
    let sent = false;
    for (const viewer of (session.viewers || [])) {
      if (viewer && viewer.readyState === 1) {
        viewer.send(message);
        sent = true;
      }
    }
    return sent;
  }
}

module.exports = MessageRouter;
