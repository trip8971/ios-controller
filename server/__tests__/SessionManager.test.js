const SessionManager = require('../SessionManager');

// Helper to create a mock WebSocket
function createMockWs(readyState = 1) {
  return {
    readyState,
    send: jest.fn(),
    close: jest.fn(),
  };
}

describe('SessionManager', () => {
  let sm;

  beforeEach(() => {
    sm = new SessionManager();
  });

  describe('registerConnection', () => {
    it('should register a device connection and create a session immediately', () => {
      const ws = createMockWs();
      const result = sm.registerConnection(ws, 'device');
      // Device registration creates a session immediately
      expect(result).not.toBeNull();
      expect(result.sessionId).toBeDefined();
      expect(result.device).toBe(ws);
      expect(sm.getRoleByWs(ws)).toBe('device');
    });

    it('should register a viewer connection', () => {
      const ws = createMockWs();
      const result = sm.registerConnection(ws, 'viewer');
      expect(result).toEqual({ registered: true });
      expect(sm.getRoleByWs(ws)).toBe('viewer');
    });

    it('should register a controller connection', () => {
      const ws = createMockWs();
      const result = sm.registerConnection(ws, 'controller');
      expect(result).toEqual({ registered: true });
      expect(sm.getRoleByWs(ws)).toBe('controller');
    });

    it('should return error for invalid role', () => {
      const ws = createMockWs();
      const result = sm.registerConnection(ws, 'invalid');
      expect(result).toEqual({ error: 'invalid_role' });
      expect(sm.getRoleByWs(ws)).toBeNull();
    });

    it('should create a session when device registers, and attach viewer and controller', () => {
      const device = createMockWs();
      const viewer = createMockWs();
      const controller = createMockWs();

      const session = sm.registerConnection(device, 'device');
      // Viewer attaches to existing session
      const viewerResult = sm.registerConnection(viewer, 'viewer');
      // Controller attaches to existing session
      const controllerResult = sm.registerConnection(controller, 'controller');

      expect(session).not.toBeNull();
      expect(session.sessionId).toBeDefined();
      expect(session.device).toBe(device);
      expect(session.viewers).toContain(viewer);
      expect(session.controller).toBe(controller);
      expect(session.createdAt).toBeInstanceOf(Date);
    });

    it('should create a session regardless of registration order (controller, device, viewer)', () => {
      const device = createMockWs();
      const viewer = createMockWs();
      const controller = createMockWs();

      sm.registerConnection(controller, 'controller');
      const session = sm.registerConnection(device, 'device');
      const viewerResult = sm.registerConnection(viewer, 'viewer');

      expect(session).not.toBeNull();
      expect(session.device).toBe(device);
      expect(session.controller).toBe(controller);
      // Viewer attaches to the session created by device
      expect(session.viewers).toContain(viewer);
    });
  });

  describe('createSession', () => {
    it('should create a session with a unique ID', () => {
      const device = createMockWs();

      const session = sm.createSession(device, null);

      expect(session.sessionId).toBeDefined();
      expect(typeof session.sessionId).toBe('string');
      expect(session.sessionId.length).toBeGreaterThan(0);
    });

    it('should store the session in the sessions map', () => {
      const device = createMockWs();

      const session = sm.createSession(device, null);

      expect(sm.sessions.get(session.sessionId)).toBe(session);
    });
  });

  describe('removeSession', () => {
    it('should remove an existing session', () => {
      const device = createMockWs();

      const session = sm.createSession(device, null);
      const result = sm.removeSession(session.sessionId);

      expect(result).toBe(true);
      expect(sm.sessions.has(session.sessionId)).toBe(false);
    });

    it('should return false for non-existent session', () => {
      const result = sm.removeSession('non-existent-id');
      expect(result).toBe(false);
    });

    it('should clean up ws-role mappings when session is removed', () => {
      const device = createMockWs();
      const controller = createMockWs();

      const session = sm.createSession(device, controller);
      sm.removeSession(session.sessionId);

      expect(sm.getRoleByWs(device)).toBeNull();
      expect(sm.getRoleByWs(controller)).toBeNull();
    });
  });

  describe('getSessionByWs', () => {
    it('should find session by device ws', () => {
      const device = createMockWs();

      const session = sm.createSession(device, null);

      expect(sm.getSessionByWs(device)).toBe(session);
    });

    it('should find session by viewer ws', () => {
      const device = createMockWs();
      const viewer = createMockWs();

      const session = sm.createSession(device, null);
      session.viewers.push(viewer);
      sm.wsRoleMap.set(viewer, 'viewer');

      expect(sm.getSessionByWs(viewer)).toBe(session);
    });

    it('should find session by controller ws', () => {
      const device = createMockWs();
      const controller = createMockWs();

      const session = sm.createSession(device, controller);

      expect(sm.getSessionByWs(controller)).toBe(session);
    });

    it('should return null for unknown ws', () => {
      const unknown = createMockWs();
      expect(sm.getSessionByWs(unknown)).toBeNull();
    });
  });

  describe('handleDisconnect', () => {
    it('should remove session when device disconnects', () => {
      const device = createMockWs();
      sm.registerConnection(device, 'device');

      // Device registration creates a session immediately, so disconnect returns it
      const session = sm.handleDisconnect(device);

      expect(session).not.toBeNull();
      expect(session.sessionId).toBeDefined();
      expect(sm.sessions.size).toBe(0);
    });

    it('should remove session when device participant disconnects', () => {
      const device = createMockWs();
      const viewer = createMockWs();
      const controller = createMockWs();

      sm.registerConnection(device, 'device');
      sm.registerConnection(viewer, 'viewer');
      sm.registerConnection(controller, 'controller');

      const session = sm.handleDisconnect(device);

      expect(session).not.toBeNull();
      expect(sm.sessions.size).toBe(0);
    });

    it('should return null for unknown ws', () => {
      const unknown = createMockWs();
      const result = sm.handleDisconnect(unknown);
      expect(result).toBeNull();
    });
  });

  describe('session uniqueness', () => {
    it('should generate unique session IDs for different sessions', () => {
      const d1 = createMockWs();
      const d2 = createMockWs();

      const session1 = sm.createSession(d1, null);
      const session2 = sm.createSession(d2, null);

      expect(session1.sessionId).not.toBe(session2.sessionId);
      expect(sm.sessions.size).toBe(2);
    });
  });

  describe('pending connection replacement', () => {
    it('should create a new session for each device registration', () => {
      const device1 = createMockWs();
      const device2 = createMockWs();

      // First device creates a session immediately
      const session1 = sm.registerConnection(device1, 'device');
      expect(session1).not.toBeNull();

      // Second device also creates a session immediately
      const session2 = sm.registerConnection(device2, 'device');
      expect(session2).not.toBeNull();

      // pendingDevice is cleared after session creation
      expect(sm.pendingDevice).toBeNull();
    });

    it('should use the latest pending connections when creating a session', () => {
      const device1 = createMockWs();
      const device2 = createMockWs();
      const viewer = createMockWs();
      const controller = createMockWs();

      sm.registerConnection(device1, 'device');
      const session2 = sm.registerConnection(device2, 'device');
      sm.registerConnection(viewer, 'viewer');
      sm.registerConnection(controller, 'controller');

      // device2 created the second session
      expect(session2).not.toBeNull();
      expect(session2.device).toBe(device2);
    });
  });

  describe('setDeviceInfo', () => {
    it('should store device info on ws object', () => {
      const device = createMockWs();
      const deviceInfo = { name: 'iPhone 16 Pro', screenWidth: 393, screenHeight: 852 };

      sm.setDeviceInfo(device, deviceInfo);

      expect(device._deviceInfo).toEqual(deviceInfo);
    });

    it('should store device info on active session', () => {
      const device = createMockWs();

      const session = sm.createSession(device, null);
      const deviceInfo = { name: 'iPhone 16 Pro', screenWidth: 393, screenHeight: 852 };

      sm.setDeviceInfo(device, deviceInfo);

      expect(session.deviceInfo).toEqual(deviceInfo);
    });
  });
});
