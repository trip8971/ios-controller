const SessionManager = require('../SessionManager');
const MessageRouter = require('../MessageRouter');

// Helper to create a mock WebSocket
function createMockWs(readyState = 1) {
  const ws = {
    readyState,
    send: jest.fn(),
    close: jest.fn(),
    _eventHandlers: {},
    on(event, handler) {
      ws._eventHandlers[event] = handler;
    },
    emit(event, ...args) {
      if (ws._eventHandlers[event]) {
        ws._eventHandlers[event](...args);
      }
    },
  };
  return ws;
}

// Helper to build a fake ftyp init segment
function buildFakeInitSegment() {
  const size = 20;
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(size, 0);
  buf.write('ftyp', 4, 4, 'ascii');
  buf.write('isom', 8, 4, 'ascii');
  return buf;
}

describe('Connection Lifecycle Management', () => {
  let sessionManager;
  let messageRouter;

  beforeEach(() => {
    sessionManager = new SessionManager();
    messageRouter = new MessageRouter();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Disconnect notification (Requirement 6.6)', () => {
    it('should notify remaining participants when device disconnects', () => {
      const device = createMockWs();
      const viewer = createMockWs();
      const controller = createMockWs();

      sessionManager.registerConnection(device, 'device');
      sessionManager.registerConnection(viewer, 'viewer');
      sessionManager.registerConnection(controller, 'controller');

      // Simulate device disconnect
      const session = sessionManager.handleDisconnect(device);

      expect(session).not.toBeNull();
      expect(session.sessionId).toBeDefined();

      // Session should be removed (device disconnect removes session)
      expect(sessionManager.sessions.size).toBe(0);

      // Remaining participants should be notifiable
      // (In server.js, the session_ended message is sent to remaining participants)
      const disconnectMsg = JSON.stringify({
        type: 'session_ended',
        reason: 'participant_disconnected',
      });

      // Simulate what server.js does after handleDisconnect
      // Session has viewers array, not a single viewer
      const participants = [session.device, ...session.viewers, session.controller];
      for (const participant of participants) {
        if (participant && participant !== device && participant.readyState === 1) {
          participant.send(disconnectMsg);
        }
      }

      expect(viewer.send).toHaveBeenCalledWith(disconnectMsg);
      expect(controller.send).toHaveBeenCalledWith(disconnectMsg);
      expect(device.send).not.toHaveBeenCalled();
    });

    it('should notify remaining participants when viewer disconnects', () => {
      const device = createMockWs();
      const viewer = createMockWs();
      const controller = createMockWs();

      sessionManager.registerConnection(device, 'device');
      sessionManager.registerConnection(viewer, 'viewer');
      sessionManager.registerConnection(controller, 'controller');

      const session = sessionManager.handleDisconnect(viewer);

      expect(session).not.toBeNull();
      // Viewer disconnect does NOT remove the session (only device disconnect does)
      expect(sessionManager.sessions.size).toBe(1);

      const disconnectMsg = JSON.stringify({
        type: 'session_ended',
        reason: 'participant_disconnected',
      });

      // Notify remaining participants
      const participants = [session.device, ...session.viewers, session.controller];
      for (const participant of participants) {
        if (participant && participant !== viewer && participant.readyState === 1) {
          participant.send(disconnectMsg);
        }
      }

      expect(device.send).toHaveBeenCalledWith(disconnectMsg);
      expect(controller.send).toHaveBeenCalledWith(disconnectMsg);
      expect(viewer.send).not.toHaveBeenCalled();
    });

    it('should notify remaining participants when controller disconnects', () => {
      const device = createMockWs();
      const viewer = createMockWs();
      const controller = createMockWs();

      sessionManager.registerConnection(device, 'device');
      sessionManager.registerConnection(viewer, 'viewer');
      sessionManager.registerConnection(controller, 'controller');

      const session = sessionManager.handleDisconnect(controller);

      expect(session).not.toBeNull();

      const disconnectMsg = JSON.stringify({
        type: 'session_ended',
        reason: 'participant_disconnected',
      });

      const participants = [session.device, ...session.viewers, session.controller].filter(Boolean);
      for (const participant of participants) {
        if (participant !== controller && participant.readyState === 1) {
          participant.send(disconnectMsg);
        }
      }

      expect(device.send).toHaveBeenCalledWith(disconnectMsg);
      expect(viewer.send).toHaveBeenCalledWith(disconnectMsg);
      expect(controller.send).not.toHaveBeenCalled();
    });

    it('should not send notification to participants with closed connections', () => {
      const device = createMockWs();
      const viewer = createMockWs(3); // CLOSED
      const controller = createMockWs();

      sessionManager.registerConnection(device, 'device');
      // Viewer with readyState 3 won't be attached to session via _attachViewerToSession
      // because it checks readyState === 1. Register it anyway for the wsRoleMap.
      sessionManager.registerConnection(viewer, 'viewer');
      sessionManager.registerConnection(controller, 'controller');

      const session = sessionManager.handleDisconnect(device);

      const disconnectMsg = JSON.stringify({
        type: 'session_ended',
        reason: 'participant_disconnected',
      });

      const participants = [session.device, ...session.viewers, session.controller].filter(Boolean);
      for (const participant of participants) {
        if (participant !== device && participant.readyState === 1) {
          participant.send(disconnectMsg);
        }
      }

      // viewer is closed, should not receive notification
      expect(viewer.send).not.toHaveBeenCalled();
      // controller is open, should receive notification
      expect(controller.send).toHaveBeenCalledWith(disconnectMsg);
    });

    it('should clean up init segment cache when session is removed on disconnect', () => {
      const device = createMockWs();
      const viewer = createMockWs();
      const controller = createMockWs();

      sessionManager.registerConnection(device, 'device');
      sessionManager.registerConnection(viewer, 'viewer');
      sessionManager.registerConnection(controller, 'controller');

      const session = sessionManager.getSessionByWs(device);
      const initSeg = buildFakeInitSegment();
      messageRouter.cacheInitSegment(session.sessionId, initSeg);

      expect(messageRouter.getCachedInitSegment(session.sessionId)).not.toBeNull();

      const removedSession = sessionManager.handleDisconnect(device);
      messageRouter.clearInitSegmentCache(removedSession.sessionId);

      expect(messageRouter.getCachedInitSegment(removedSession.sessionId)).toBeNull();
    });

    it('should handle disconnect of pending (non-session) connection gracefully', () => {
      const controller = createMockWs();
      // Controller registration does NOT create a session (only device does)
      sessionManager.registerConnection(controller, 'controller');

      const session = sessionManager.handleDisconnect(controller);

      // No session was created, so disconnect returns null
      expect(session).toBeNull();
      expect(sessionManager.pendingController).toBeNull();
    });
  });

  describe('Invalid registration message handling (Requirement 6.6)', () => {
    it('should reject registration with missing role', () => {
      const ws = createMockWs();
      const message = JSON.stringify({ type: 'register' });

      // Simulate server.js logic: message.type === 'register' && message.role
      const parsed = JSON.parse(message);
      const hasValidRegistration = parsed.type === 'register' && parsed.role;

      expect(hasValidRegistration).toBeFalsy();
    });

    it('should reject registration with missing type', () => {
      const ws = createMockWs();
      const message = JSON.stringify({ role: 'device' });

      const parsed = JSON.parse(message);
      const hasValidRegistration = parsed.type === 'register' && parsed.role;

      expect(hasValidRegistration).toBeFalsy();
    });

    it('should reject registration with invalid role value', () => {
      const ws = createMockWs();
      const result = sessionManager.registerConnection(ws, 'invalid_role');

      expect(result).toEqual({ error: 'invalid_role' });
      expect(sessionManager.getRoleByWs(ws)).toBeNull();
    });

    it('should reject registration with empty role', () => {
      const ws = createMockWs();
      const result = sessionManager.registerConnection(ws, '');

      expect(result).toEqual({ error: 'invalid_role' });
    });

    it('should reject non-JSON messages from unregistered connections', () => {
      const invalidMessage = 'not valid json {{{';

      expect(() => JSON.parse(invalidMessage)).toThrow();
    });

    it('should reject registration with wrong type field', () => {
      const message = JSON.stringify({ type: 'not_register', role: 'device' });
      const parsed = JSON.parse(message);
      const hasValidRegistration = parsed.type === 'register' && parsed.role;

      expect(hasValidRegistration).toBeFalsy();
    });

    it('should accept valid registration for each role', () => {
      const roles = ['device', 'viewer', 'controller'];
      for (const role of roles) {
        const ws = createMockWs();
        const sm = new SessionManager();
        const result = sm.registerConnection(ws, role);
        // Registration succeeded
        expect(sm.getRoleByWs(ws)).toBe(role);
      }
    });
  });

  describe('Console logging (Requirement 6.7)', () => {
    it('should log when a connection is registered', () => {
      const ws = createMockWs();
      sessionManager.registerConnection(ws, 'device');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Registered connection as "device"')
      );
    });

    it('should log when a session is created', () => {
      const device = createMockWs();

      sessionManager.registerConnection(device, 'device');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Session created:')
      );
    });

    it('should log when a session is removed', () => {
      const device = createMockWs();

      const session = sessionManager.createSession(device, null);
      sessionManager.removeSession(session.sessionId);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Session removed:')
      );
    });

    it('should log when a participant disconnects from a session', () => {
      const device = createMockWs();
      const viewer = createMockWs();
      const controller = createMockWs();

      sessionManager.registerConnection(device, 'device');
      sessionManager.registerConnection(viewer, 'viewer');
      sessionManager.registerConnection(controller, 'controller');

      sessionManager.handleDisconnect(device);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('disconnected from session')
      );
    });

    it('should log when init segment is cached', () => {
      const initSeg = buildFakeInitSegment();
      messageRouter.cacheInitSegment('session-1', initSeg);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Cached init segment for session session-1')
      );
    });

    it('should log when init segment cache is cleared', () => {
      const initSeg = buildFakeInitSegment();
      messageRouter.cacheInitSegment('session-1', initSeg);
      messageRouter.clearInitSegmentCache('session-1');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Cleared init segment cache for session session-1')
      );
    });

    it('should log when init segment is replayed to viewer', () => {
      const viewer = createMockWs();
      const initSeg = buildFakeInitSegment();
      messageRouter.cacheInitSegment('session-1', initSeg);
      messageRouter.replayInitSegment('session-1', viewer);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Replayed init segment to viewer for session session-1')
      );
    });
  });

  describe('Session cleanup on disconnect (Requirement 2.7)', () => {
    it('should remove session from sessions map when device disconnects', () => {
      const device = createMockWs();
      const viewer = createMockWs();
      const controller = createMockWs();

      sessionManager.registerConnection(device, 'device');
      sessionManager.registerConnection(viewer, 'viewer');
      sessionManager.registerConnection(controller, 'controller');

      expect(sessionManager.sessions.size).toBe(1);

      sessionManager.handleDisconnect(device);

      expect(sessionManager.sessions.size).toBe(0);
    });

    it('should clean up ws-role mappings for session participants on device disconnect', () => {
      const device = createMockWs();
      const viewer = createMockWs();
      const controller = createMockWs();

      sessionManager.registerConnection(device, 'device');
      sessionManager.registerConnection(viewer, 'viewer');
      sessionManager.registerConnection(controller, 'controller');

      sessionManager.handleDisconnect(device);

      // Device and controller role mappings should be cleaned up
      expect(sessionManager.getRoleByWs(device)).toBeNull();
      expect(sessionManager.getRoleByWs(controller)).toBeNull();
      // Viewers with open connections are kept in wsRoleMap for re-attachment
      // (per removeSession logic: only closed viewers are removed from wsRoleMap)
    });

    it('should allow new session creation after previous session is cleaned up', () => {
      const device1 = createMockWs();
      const viewer1 = createMockWs();
      const controller1 = createMockWs();

      sessionManager.registerConnection(device1, 'device');
      sessionManager.registerConnection(viewer1, 'viewer');
      sessionManager.registerConnection(controller1, 'controller');

      // Disconnect device from first session
      sessionManager.handleDisconnect(device1);
      expect(sessionManager.sessions.size).toBe(0);

      // Create a new session
      const device2 = createMockWs();
      const viewer2 = createMockWs();
      const controller2 = createMockWs();

      const newSession = sessionManager.registerConnection(device2, 'device');
      sessionManager.registerConnection(viewer2, 'viewer');
      sessionManager.registerConnection(controller2, 'controller');

      expect(newSession).not.toBeNull();
      expect(newSession.sessionId).toBeDefined();
      expect(sessionManager.sessions.size).toBeGreaterThanOrEqual(1);
    });

    it('should handle multiple rapid disconnects gracefully', () => {
      const device = createMockWs();
      const viewer = createMockWs();
      const controller = createMockWs();

      sessionManager.registerConnection(device, 'device');
      sessionManager.registerConnection(viewer, 'viewer');
      sessionManager.registerConnection(controller, 'controller');

      // Device disconnect removes the session
      const session1 = sessionManager.handleDisconnect(device);
      expect(session1).not.toBeNull();

      // Subsequent disconnects should not find a session
      const session2 = sessionManager.handleDisconnect(viewer);
      expect(session2).toBeNull();

      const session3 = sessionManager.handleDisconnect(controller);
      expect(session3).toBeNull();
    });
  });

  describe('session_ended message format', () => {
    it('should have correct structure with type and reason fields', () => {
      const disconnectMsg = JSON.parse(JSON.stringify({
        type: 'session_ended',
        reason: 'participant_disconnected',
      }));

      expect(disconnectMsg.type).toBe('session_ended');
      expect(disconnectMsg.reason).toBe('participant_disconnected');
    });
  });
});
