import type WebSocket from 'ws';
import type { Session } from './SessionManager';

/** ftyp box magic bytes: ASCII "ftyp" at offset 4 */
const FTYP_MAGIC = Buffer.from('ftyp', 'ascii');
const FTYP_OFFSET = 4;

class MessageRouter {
  private initSegmentCache = new Map<string, Buffer>();
  private lastKeyframeCache = new Map<string, Buffer>();

  isBinary(message: unknown): boolean {
    return Buffer.isBuffer(message) || message instanceof ArrayBuffer || message instanceof Uint8Array;
  }

  isInitSegment(data: Buffer | ArrayBuffer | Uint8Array): boolean {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (buf.length < FTYP_OFFSET + FTYP_MAGIC.length) {
      return false;
    }
    return buf.subarray(FTYP_OFFSET, FTYP_OFFSET + FTYP_MAGIC.length).equals(FTYP_MAGIC);
  }

  cacheInitSegment(sessionId: string, data: Buffer | ArrayBuffer | Uint8Array): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    this.initSegmentCache.set(sessionId, buf);
    console.log(`[MessageRouter] Cached init segment for session ${sessionId} (${buf.length} bytes)`);
  }

  getCachedInitSegment(sessionId: string): Buffer | null {
    return this.initSegmentCache.get(sessionId) || null;
  }

  clearInitSegmentCache(sessionId: string): void {
    if (this.initSegmentCache.delete(sessionId)) {
      console.log(`[MessageRouter] Cleared init segment cache for session ${sessionId}`);
    }
    this.lastKeyframeCache.delete(sessionId);
  }

  replayInitSegment(sessionId: string, viewerWs: WebSocket): boolean {
    const initSegment = this.getCachedInitSegment(sessionId);
    if (initSegment && viewerWs && (viewerWs as any).readyState === 1) {
      viewerWs.send(initSegment);
      console.log(`[MessageRouter] Replayed init segment to viewer for session ${sessionId}`);
      return true;
    }
    return false;
  }

  route(ws: WebSocket, message: unknown, role: string, session: Session): boolean {
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

  private _routeDeviceMessage(message: unknown, session: Session): boolean {
    if (this.isBinary(message)) {
      if (this.isInitSegment(message as Buffer)) {
        this.cacheInitSegment(session.sessionId, message as Buffer);
      }

      let sent = false;
      for (const viewer of session.viewers || []) {
        if (viewer && (viewer as any).readyState === 1) {
          viewer.send(message as Buffer);
          sent = true;
        }
      }
      return sent;
    }
    return false;
  }

  private _routeViewerMessage(message: unknown, session: Session): boolean {
    if (session.controller && (session.controller as any).readyState === 1) {
      session.controller.send(message as Buffer | string);
      return true;
    }
    return false;
  }

  private _routeControllerMessage(message: unknown, session: Session): boolean {
    let sent = false;
    for (const viewer of session.viewers || []) {
      if (viewer && (viewer as any).readyState === 1) {
        viewer.send(message as Buffer | string);
        sent = true;
      }
    }
    return sent;
  }
}

export default MessageRouter;
