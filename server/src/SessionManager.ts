import { randomUUID } from 'crypto';
import type WebSocket from 'ws';

export interface Session {
  sessionId: string;
  device: WebSocket | null;
  viewers: WebSocket[];
  controller: WebSocket | null;
  createdAt: Date;
  deviceInfo: Record<string, unknown> | null;
}

export type Role = 'device' | 'viewer' | 'controller';

export interface RegisterResult {
  error?: string;
  registered?: boolean;
  sessionId?: string;
  device?: WebSocket | null;
  viewers?: WebSocket[];
  controller?: WebSocket | null;
  deviceInfo?: Record<string, unknown> | null;
}

class SessionManager {
  private sessions = new Map<string, Session>();
  private pendingDevice: WebSocket | null = null;
  private pendingController: WebSocket | null = null;
  private wsRoleMap = new Map<WebSocket, Role>();

  registerConnection(ws: WebSocket, role: string): RegisterResult {
    const validRoles: string[] = ['device', 'viewer', 'controller'];
    if (!validRoles.includes(role)) {
      return { error: 'invalid_role' };
    }

    this.wsRoleMap.set(ws, role as Role);

    if (role === 'device') {
      this.pendingDevice = ws;
    } else if (role === 'viewer') {
      const session = this._attachViewerToSession(ws);
      if (session) return session;
    } else if (role === 'controller') {
      this.pendingController = ws;
    }

    console.log(`[SessionManager] Registered connection as "${role}"`);
    const session = this._tryCreateSession();
    return session || { registered: true };
  }

  private _attachViewerToSession(ws: WebSocket): Session | null {
    for (const session of this.sessions.values()) {
      if (session.device && (session.device as any).readyState === 1) {
        session.viewers.push(ws);
        this.wsRoleMap.set(ws, 'viewer');
        console.log(`[SessionManager] Viewer joined session ${session.sessionId} (${session.viewers.length} viewers)`);
        return session;
      }
    }
    return null;
  }

  private _tryCreateSession(): Session | null {
    if (this.pendingDevice) {
      const session = this.createSession(this.pendingDevice, this.pendingController);
      this.pendingDevice = null;
      this.pendingController = null;

      for (const [ws, role] of this.wsRoleMap.entries()) {
        if (role === 'viewer' && !this.getSessionByWs(ws) && (ws as any).readyState === 1) {
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

  createSession(deviceWs: WebSocket, controllerWs: WebSocket | null): Session {
    const sessionId = randomUUID();
    const session: Session = {
      sessionId,
      device: deviceWs,
      viewers: [],
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

  removeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.device) this.wsRoleMap.delete(session.device);
    for (const v of session.viewers) {
      if ((v as any).readyState !== 1) this.wsRoleMap.delete(v);
    }
    if (session.controller) this.wsRoleMap.delete(session.controller);

    this.sessions.delete(sessionId);
    console.log(`[SessionManager] Session removed: ${sessionId}`);
    return true;
  }

  getSessionByWs(ws: WebSocket): Session | null {
    for (const session of this.sessions.values()) {
      if (session.device === ws) return session;
      if (session.viewers.includes(ws)) return session;
      if (session.controller === ws) return session;
    }
    return null;
  }

  getRoleByWs(ws: WebSocket): Role | null {
    return this.wsRoleMap.get(ws) || null;
  }

  handleDisconnect(ws: WebSocket): Session | null {
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

  setDeviceInfo(ws: WebSocket, deviceInfo: Record<string, unknown>): void {
    const session = this.getSessionByWs(ws);
    if (session) session.deviceInfo = deviceInfo;
    (ws as any)._deviceInfo = deviceInfo;
  }
}

export default SessionManager;
