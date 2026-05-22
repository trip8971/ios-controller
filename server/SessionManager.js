const crypto = require('crypto');

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.pendingDevice = null;
    this.pendingController = null;
    // Map ws → role
    this.wsRoleMap = new Map();
  }

  registerConnection(ws, role) {
    const validRoles = ['device', 'viewer', 'controller'];
    if (!validRoles.includes(role)) {
      return { error: 'invalid_role' };
    }

    this.wsRoleMap.set(ws, role);

    if (role === 'device') {
      this.pendingDevice = ws;
    } else if (role === 'viewer') {
      // Viewer goes directly into an existing session or waits for device
      const session = this._attachViewerToSession(ws);
      if (session) return session;
      // No session yet — store as pending and try to create
    } else if (role === 'controller') {
      this.pendingController = ws;
    }

    console.log(`[SessionManager] Registered connection as "${role}"`);
    const session = this._tryCreateSession();
    return session || { registered: true };
  }

  /** Attach a viewer to an existing session that has a device */
  _attachViewerToSession(ws) {
    for (const session of this.sessions.values()) {
      if (session.device && session.device.readyState === 1) {
        session.viewers.push(ws);
        this.wsRoleMap.set(ws, 'viewer');
        console.log(`[SessionManager] Viewer joined session ${session.sessionId} (${session.viewers.length} viewers)`);
        return session;
      }
    }
    return null;
  }

  _tryCreateSession() {
    if (this.pendingDevice) {
      const session = this.createSession(this.pendingDevice, this.pendingController);
      this.pendingDevice = null;
      this.pendingController = null;

      // Attach all orphan viewers (connected but not in any session)
      for (const [ws, role] of this.wsRoleMap.entries()) {
        if (role === 'viewer' && !this.getSessionByWs(ws) && ws.readyState === 1) {
          session.viewers.push(ws);
          console.log(`[SessionManager] Orphan viewer attached to session ${session.sessionId}`);
        }
      }
      console.log(`[SessionManager] Session ${session.sessionId} has ${session.viewers.length} viewers`);
      return session;
    }
    if (this.pendingController) {
      for (const session of this.sessions.values()) {
        if (!session.controller) {
          session.controller = this.pendingController;
          this.wsRoleMap.set(this.pendingController, 'controller');
          this.pendingController = null;
          console.log(`[SessionManager] Controller joined session ${session.sessionId}`);
          return session;
        }
      }
    }
    return null;
  }

  createSession(deviceWs, controllerWs) {
    const sessionId = crypto.randomUUID();
    const session = {
      sessionId,
      device: deviceWs,
      viewers: [],       // multiple viewers
      controller: controllerWs || null,
      createdAt: new Date(),
      deviceInfo: null,
    };

    this.sessions.set(sessionId, session);
    this.wsRoleMap.set(deviceWs, 'device');
    if (controllerWs) this.wsRoleMap.set(controllerWs, 'controller');

    console.log(`[SessionManager] Session created: ${sessionId}`);
    return session;
  }

  removeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.device) this.wsRoleMap.delete(session.device);
    // Keep viewers in wsRoleMap so they can be attached to a new session
    // Only remove closed viewers
    for (const v of session.viewers) {
      if (v.readyState !== 1) this.wsRoleMap.delete(v);
    }
    if (session.controller) this.wsRoleMap.delete(session.controller);

    this.sessions.delete(sessionId);
    console.log(`[SessionManager] Session removed: ${sessionId}`);
    return true;
  }

  getSessionByWs(ws) {
    for (const session of this.sessions.values()) {
      if (session.device === ws) return session;
      if (session.viewers.includes(ws)) return session;
      if (session.controller === ws) return session;
    }
    return null;
  }

  getRoleByWs(ws) {
    return this.wsRoleMap.get(ws) || null;
  }

  handleDisconnect(ws) {
    const role = this.wsRoleMap.get(ws);

    if (this.pendingDevice === ws) this.pendingDevice = null;
    if (this.pendingController === ws) this.pendingController = null;

    const session = this.getSessionByWs(ws);
    if (session) {
      console.log(`[SessionManager] "${role}" disconnected from session ${session.sessionId}`);

      if (role === 'device') {
        this.removeSession(session.sessionId);
        return session;
      }

      this.wsRoleMap.delete(ws);
      if (role === 'viewer') {
        session.viewers = session.viewers.filter(v => v !== ws);
        console.log(`[SessionManager] Viewer removed, ${session.viewers.length} viewers remaining`);
        // Clean up session if no device and no viewers
        if (!session.device && session.viewers.length === 0) {
          this.removeSession(session.sessionId);
        }
      } else if (role === 'controller') {
        session.controller = null;
      }
      return session;
    }

    this.wsRoleMap.delete(ws);
    return null;
  }

  setDeviceInfo(ws, deviceInfo) {
    const session = this.getSessionByWs(ws);
    if (session) session.deviceInfo = deviceInfo;
    ws._deviceInfo = deviceInfo;
  }
}

module.exports = SessionManager;
