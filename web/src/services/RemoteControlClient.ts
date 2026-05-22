import { VideoPlayer } from './VideoPlayer';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export interface ControlCommand {
  type: string;
  cmdId?: number;
  x?: number;
  y?: number;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  normalized?: boolean;
  duration?: number;
  text?: string;
  clearText?: boolean;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * RemoteControlClient - WebSocket 客户端
 *
 * 负责与 Signaling_Server 建立 WebSocket 连接，
 * 接收视频流数据并转发给 VideoPlayer，
 * 发送控制指令到服务器。
 */
export class RemoteControlClient {
  serverUrl: string;
  private ws: WebSocket | null = null;
  private videoPlayer: VideoPlayer | null = null;
  connected = false;
  private videoReceived = false;

  // 重连机制
  retryCount = 0;
  maxRetries = 10;
  retryInterval = 3000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  hasConnectedBefore = false;
  private intentionalDisconnect = false;

  // 回调
  onStatusChange: ((status: ConnectionStatus) => void) | null = null;
  onSessionReady: ((msg: Record<string, unknown>) => void) | null = null;
  onSessionEnded: ((msg: Record<string, unknown>) => void) | null = null;
  onVideoReceived: (() => void) | null = null;

  // 指令应答 Promise 管理
  private _pendingCommands = new Map<number, PendingCommand>();
  private _nextCmdId = 0;

  constructor(serverUrl?: string) {
    this.serverUrl = serverUrl || 'ws://localhost:8080';
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      console.log('[RemoteControlClient] Already connected or connecting');
      return;
    }

    this.intentionalDisconnect = false;
    this.onStatusChange?.('connecting');
    console.log('[RemoteControlClient] Connecting to', this.serverUrl);

    this.ws = new WebSocket(this.serverUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('[RemoteControlClient] Connected');
      this.connected = true;
      this.hasConnectedBefore = true;
      this.retryCount = 0;
      this.onStatusChange?.('connected');

      this._sendJSON({ type: 'register', role: 'viewer' });
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this._handleMessage(event.data);
    };

    this.ws.onclose = (event: CloseEvent) => {
      console.log('[RemoteControlClient] Disconnected, code:', event.code);
      const wasConnected = this.connected;
      this.connected = false;
      this.videoReceived = false;
      this.onStatusChange?.('disconnected');

      if (this.intentionalDisconnect) return;

      if (wasConnected && this.hasConnectedBefore) {
        console.log('[RemoteControlClient] Mid-session disconnect, auto-reconnecting');
        this.retryCount = 0;
        this._scheduleReconnect();
      } else {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = (error: Event) => {
      console.error('[RemoteControlClient] WebSocket error:', error);
    };
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this._cancelReconnect();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.videoReceived = false;
    this.onStatusChange?.('disconnected');
  }

  onVideoData(data: ArrayBuffer): void {
    if (this.videoPlayer) {
      if (!this.videoReceived) {
        this.videoReceived = true;
        this.onVideoReceived?.();
      }
      this.videoPlayer.appendData(data);
    }
  }

  sendCommand(cmd: ControlCommand): Promise<unknown> {
    console.log('[RemoteControlClient] sendCommand:', cmd.type, 'wsState:', this.ws ? this.ws.readyState : 'null');
    return new Promise((resolve, reject) => {
      const cmdId = this._nextCmdId++;
      const timer = setTimeout(() => {
        this._pendingCommands.delete(cmdId);
        reject(new Error('command timeout'));
      }, 10000);
      this._pendingCommands.set(cmdId, { resolve, reject, timer });
      this._sendJSON({ ...cmd, cmdId });
    });
  }

  setVideoPlayer(player: VideoPlayer): void {
    this.videoPlayer = player;
  }

  manualReconnect(): void {
    this.retryCount = 0;
    this.hasConnectedBefore = false;
    this.connect();
  }

  private _scheduleReconnect(): void {
    this._cancelReconnect();

    if (this.retryCount >= this.maxRetries) {
      console.log('[RemoteControlClient] Max retries reached (' + this.maxRetries + ')');
      this.onStatusChange?.('disconnected');
      return;
    }

    this.retryCount++;
    const interval = this.retryInterval;
    console.log(`[RemoteControlClient] Scheduling reconnect attempt ${this.retryCount}/${this.maxRetries} in ${interval}ms`);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, interval);
  }

  private _cancelReconnect(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private _handleMessage(data: ArrayBuffer | string): void {
    if (data instanceof ArrayBuffer) {
      this.onVideoData(data);
    } else if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        this._handleJSONMessage(msg);
      } catch (e) {
        console.error('[RemoteControlClient] Invalid JSON message:', e);
      }
    }
  }

  private _handleJSONMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'cmd_result':
        if (this._pendingCommands.has(msg.cmdId as number)) {
          const { resolve, reject, timer } = this._pendingCommands.get(msg.cmdId as number)!;
          clearTimeout(timer);
          this._pendingCommands.delete(msg.cmdId as number);
          if (msg.ok) {
            resolve(msg);
          } else {
            reject(new Error((msg.error as string) || 'command failed'));
          }
        }
        break;

      case 'session_ready':
        console.log('[RemoteControlClient] Session ready');
        this.onSessionReady?.(msg);
        break;

      case 'session_ended':
        console.log('[RemoteControlClient] Session ended, destroying video player');
        this.videoReceived = false;
        if (this.videoPlayer) {
          this.videoPlayer.destroy();
          this.videoPlayer.init().then(() => {
            console.log('[RemoteControlClient] VideoPlayer reinitialized');
          }).catch((err) => {
            console.error('[RemoteControlClient] VideoPlayer reinit failed:', err);
          });
        }
        this.onSessionEnded?.(msg);
        break;

      case 'error':
        console.error('[RemoteControlClient] Server error:', msg.message);
        break;

      default:
        console.log('[RemoteControlClient] Unknown message type:', msg.type);
    }
  }

  private _sendJSON(obj: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    } else {
      console.warn('[RemoteControlClient] Cannot send, WebSocket not open');
    }
  }
}
