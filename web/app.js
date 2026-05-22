// ============================================================
// iOS 远程控制 - Web 客户端
// ============================================================

/**
 * VideoPlayer - 基于 Media Source Extensions (MSE) 的视频播放器
 *
 * 负责接收 fMP4 segments 并通过 MSE SourceBuffer 解码播放 H.264 视频流。
 * 实现低延迟策略和缓冲区清理。
 */
class VideoPlayer {
  /**
   * @param {HTMLVideoElement} videoElement - 用于播放视频的 <video> 元素
   */
  constructor(videoElement) {
    this.video = videoElement;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.isAppending = false;
    this.initialized = false;
    this.hasInitSegment = false;
    this.latencyInterval = null;
    this.cleanupInterval = null;

    /** @type {string} MSE MIME 类型 - H.264 (通用，让浏览器从 init segment 推断具体 profile) */
    this.mimeType = 'video/mp4; codecs="avc1.640029"';

    /** @type {number} 低延迟跳转检查间隔（毫秒） */
    this.latencyCheckInterval = 200;

    /** @type {number} 缓冲区清理检查间隔（毫秒） */
    this.cleanupCheckInterval = 3000;

    /** @type {number} 缓冲区最大保留时长（秒） */
    this.maxBufferDuration = 5;

    /** @type {number} 延迟阈值（秒），超过此值则跳转到最新位置 */
    this.latencyThreshold = 0.2;
  }

  /**
   * 初始化 MediaSource 并绑定到 video 元素
   * @returns {Promise<void>}
   */
  init() {
    return new Promise((resolve, reject) => {
      if (typeof MediaSource === 'undefined') {
        reject(new Error('MediaSource API is not supported in this browser'));
        return;
      }

      this.mediaSource = new MediaSource();
      this.video.src = URL.createObjectURL(this.mediaSource);

      this.mediaSource.addEventListener('sourceopen', () => {
        try {
          this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mimeType);
          this.sourceBuffer.mode = 'segments';

          this.sourceBuffer.addEventListener('updateend', () => {
            this.isAppending = false;
            this._processQueue();
          });

          this.sourceBuffer.addEventListener('error', (e) => {
            console.error('[VideoPlayer] SourceBuffer error:', e);
          });

          this.initialized = true;
          this._startLatencyCheck();
          this._startCleanupCheck();
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      this.mediaSource.addEventListener('sourceclose', () => {
        console.log('[VideoPlayer] MediaSource closed');
        this._stopIntervals();
      });

      this.mediaSource.addEventListener('sourceended', () => {
        console.log('[VideoPlayer] MediaSource ended');
      });
    });
  }

  /**
   * 追加 fMP4 segment 数据到 SourceBuffer
   * 自动区分 init segment 和 media segment
   * @param {ArrayBuffer} arrayBuffer - fMP4 segment 数据
   */
  appendData(arrayBuffer) {
    if (!this.initialized || !this.sourceBuffer) {
      console.warn('[VideoPlayer] Not initialized, dropping data');
      return;
    }

    if (this._isInitSegment(arrayBuffer)) {
      this.onInitSegment(arrayBuffer);
    } else {
      this.onMediaSegment(arrayBuffer);
    }
  }

  /**
   * 处理 init segment（ftyp + moov）
   * @param {ArrayBuffer} data - init segment 数据
   */
  onInitSegment(data) {
    if (!this.initialized || !this.sourceBuffer) {
      console.warn('[VideoPlayer] Not initialized, cannot append init segment');
      return;
    }

    console.log('[VideoPlayer] Init segment received (' + data.byteLength + ' bytes)');

    // 如果已经有旧的 init segment，完全重建 MediaSource
    if (this.hasInitSegment) {
      console.log('[VideoPlayer] Rebuilding MediaSource for new stream');
      this._rebuild(data);
      return;
    }

    this.queue = [];
    this.hasInitSegment = true;
    this._enqueue(data);
  }

  /**
   * 完全重建 MediaSource（用于 device 重连场景）
   */
  _rebuild(initData) {
    this._stopIntervals();

    // 保存 video 元素引用
    const video = this.video;

    // 清理旧的
    try {
      if (this.sourceBuffer && this.sourceBuffer.updating) {
        this.sourceBuffer.abort();
      }
      if (this.mediaSource && this.mediaSource.readyState === 'open') {
        this.mediaSource.endOfStream();
      }
    } catch (e) { /* ignore */ }

    if (video.src) {
      URL.revokeObjectURL(video.src);
    }

    // 重置状态
    this.sourceBuffer = null;
    this.mediaSource = null;
    this.queue = [];
    this.isAppending = false;
    this.hasInitSegment = false;

    // 重新创建 MediaSource
    this.mediaSource = new MediaSource();
    video.src = URL.createObjectURL(this.mediaSource);

    this.mediaSource.addEventListener('sourceopen', () => {
      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mimeType);
        this.sourceBuffer.mode = 'segments';
        this.sourceBuffer.addEventListener('updateend', () => {
          this.isAppending = false;
          this._processQueue();
        });
        this.sourceBuffer.addEventListener('error', (e) => {
          console.error('[VideoPlayer] SourceBuffer error:', e);
        });

        this.initialized = true;
        this.hasInitSegment = true;
        this._startLatencyCheck();
        this._startCleanupCheck();

        // 追加新的 init segment
        this._enqueue(initData);
        console.log('[VideoPlayer] MediaSource rebuilt, init segment queued');
      } catch (e) {
        console.error('[VideoPlayer] Rebuild error:', e);
      }
    });
  }

  /**
   * 处理 media segment（moof + mdat）
   * @param {ArrayBuffer} data - media segment 数据
   */
  onMediaSegment(data) {
    if (!this.initialized || !this.sourceBuffer) {
      console.warn('[VideoPlayer] Not initialized, cannot append media segment');
      return;
    }

    if (!this.hasInitSegment) {
      console.warn('[VideoPlayer] No init segment yet, dropping media segment');
      return;
    }

    this._enqueue(data);
  }

  /**
   * 销毁播放器，释放资源
   */
  destroy() {
    this._stopIntervals();

    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try {
        if (this.sourceBuffer) {
          this.mediaSource.removeSourceBuffer(this.sourceBuffer);
        }
        this.mediaSource.endOfStream();
      } catch (e) {
        // ignore errors during cleanup
      }
    }

    if (this.video.src) {
      URL.revokeObjectURL(this.video.src);
      this.video.src = '';
    }

    this.sourceBuffer = null;
    this.mediaSource = null;
    this.queue = [];
    this.isAppending = false;
    this.initialized = false;
    this.hasInitSegment = false;
  }

  // ---- Private Methods ----

  /**
   * 检测是否为 init segment（以 ftyp box 开头）
   * ftyp box 的 type 字段为 ASCII "ftyp" (0x66747970)
   * @param {ArrayBuffer} buffer
   * @returns {boolean}
   */
  _isInitSegment(buffer) {
    if (buffer.byteLength < 8) return false;
    const view = new DataView(buffer);
    // Box type is at bytes 4-7
    const boxType = view.getUint32(4);
    // 'ftyp' = 0x66747970
    return boxType === 0x66747970;
  }

  /**
   * 将数据加入追加队列
   * @param {ArrayBuffer} data
   */
  _enqueue(data) {
    this.queue.push(data);
    this._processQueue();
  }

  /**
   * 处理追加队列，依次将数据追加到 SourceBuffer
   */
  _processQueue() {
    if (this.isAppending || this.queue.length === 0) return;
    if (!this.sourceBuffer || this.mediaSource.readyState !== 'open') return;

    this.isAppending = true;
    const data = this.queue.shift();

    try {
      this.sourceBuffer.appendBuffer(data);
    } catch (e) {
      console.error('[VideoPlayer] appendBuffer error:', e);
      this.isAppending = false;

      // QuotaExceededError - 缓冲区满，清理后重试
      if (e.name === 'QuotaExceededError') {
        this._cleanupBuffer(true);
        this.queue.unshift(data);
        // 等待 remove 完成后重试
      }
    }
  }

  /**
   * 启动低延迟检查定时器
   * 定期将 video.currentTime 跳转到 buffered.end 最新位置
   */
  _startLatencyCheck() {
    this.latencyInterval = setInterval(() => {
      this._jumpToLive();
    }, this.latencyCheckInterval);
  }

  /**
   * 启动缓冲区清理定时器
   */
  _startCleanupCheck() {
    this.cleanupInterval = setInterval(() => {
      this._cleanupBuffer(false);
    }, this.cleanupCheckInterval);
  }

  /**
   * 停止所有定时器
   */
  _stopIntervals() {
    if (this.latencyInterval) {
      clearInterval(this.latencyInterval);
      this.latencyInterval = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * 低延迟策略：跳转到缓冲区最新位置
   */
  _jumpToLive() {
    if (!this.video || !this.video.buffered || this.video.buffered.length === 0) return;

    const bufferedEnd = this.video.buffered.end(this.video.buffered.length - 1);
    const currentTime = this.video.currentTime;
    const lag = bufferedEnd - currentTime;

    if (lag > this.latencyThreshold) {
      this.video.currentTime = bufferedEnd;
    }
  }

  /**
   * 缓冲区清理：移除旧数据以防止内存溢出
   * @param {boolean} force - 是否强制清理（QuotaExceededError 时）
   */
  _cleanupBuffer(force) {
    if (!this.sourceBuffer || this.sourceBuffer.updating) return;
    if (!this.video.buffered || this.video.buffered.length === 0) return;

    const bufferedStart = this.video.buffered.start(0);
    const bufferedEnd = this.video.buffered.end(this.video.buffered.length - 1);
    const bufferedDuration = bufferedEnd - bufferedStart;

    if (force || bufferedDuration > this.maxBufferDuration) {
      const removeEnd = bufferedEnd - (force ? 2 : this.maxBufferDuration / 2);
      if (removeEnd > bufferedStart) {
        try {
          this.sourceBuffer.remove(bufferedStart, removeEnd);
        } catch (e) {
          console.error('[VideoPlayer] Buffer cleanup error:', e);
        }
      }
    }
  }
}


/**
 * RemoteControlClient - WebSocket 客户端
 *
 * 负责与 Signaling_Server 建立 WebSocket 连接，
 * 接收视频流数据并转发给 VideoPlayer，
 * 发送控制指令到服务器。
 */
class RemoteControlClient {
  /**
   * @param {string} serverUrl - WebSocket 服务器地址，默认 ws://localhost:8080
   */
  constructor(serverUrl) {
    this.serverUrl = serverUrl || 'ws://localhost:8080';
    this.ws = null;
    this.videoPlayer = null;
    this.connected = false;

    // UI 元素引用
    this.statusDot = null;
    this.statusText = null;
    this.waitingOverlay = null;
    this.reconnectOverlay = null;
    this.videoReceived = false;

    // 重连机制属性
    /** @type {number} 当前重试次数 */
    this.retryCount = 0;
    /** @type {number} 最大重试次数 */
    this.maxRetries = 10;
    /** @type {number} 重试间隔（毫秒） */
    this.retryInterval = 3000;
    /** @type {number|null} 重试定时器 ID */
    this.retryTimer = null;
    /** @type {boolean} 是否曾经成功连接过（用于区分初始连接失败和 Session 中断） */
    this.hasConnectedBefore = false;
    /** @type {boolean} 是否由用户主动断开（不触发重连） */
    this.intentionalDisconnect = false;

    // 回调
    this.onStatusChange = null;
    this.onSessionReady = null;
    this.onSessionEnded = null;

    // 指令应答 Promise 管理
    this._pendingCommands = new Map();
    this._nextCmdId = 0;
  }

  /**
   * 建立 WebSocket 连接
   * 连接成功后自动发送 viewer 注册消息
   */
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      console.log('[RemoteControlClient] Already connected or connecting');
      return;
    }

    this.intentionalDisconnect = false;
    this._updateStatus('connecting');
    this._hideReconnectOverlay();
    console.log('[RemoteControlClient] Connecting to', this.serverUrl);

    this.ws = new WebSocket(this.serverUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('[RemoteControlClient] Connected');
      this.connected = true;
      this.hasConnectedBefore = true;
      this.retryCount = 0;
      this._updateStatus('connected');
      this._hideReconnectOverlay();

      // 发送 viewer 注册消息
      this._sendJSON({ type: 'register', role: 'viewer' });
    };

    this.ws.onmessage = (event) => {
      this._handleMessage(event.data);
    };

    this.ws.onclose = (event) => {
      console.log('[RemoteControlClient] Disconnected, code:', event.code);
      const wasConnected = this.connected;
      this.connected = false;
      this.videoReceived = false;
      this._updateStatus('disconnected');
      this._showWaitingOverlay();

      if (this.intentionalDisconnect) {
        return;
      }

      if (wasConnected && this.hasConnectedBefore) {
        // Session 期间连接断开：显示"连接已断开"提示并自动重连（重置重试计数）
        console.log('[RemoteControlClient] Mid-session disconnect, auto-reconnecting');
        this.retryCount = 0;
        this._scheduleReconnect();
      } else {
        // 初始连接失败或连接未成功：按重试逻辑处理
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = (error) => {
      console.error('[RemoteControlClient] WebSocket error:', error);
    };
  }

  /**
   * 断开 WebSocket 连接
   */
  disconnect() {
    this.intentionalDisconnect = true;
    this._cancelReconnect();
    if (this.ws) {
      this.ws.onclose = null; // 防止触发重连
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.videoReceived = false;
    this._updateStatus('disconnected');
    this._showWaitingOverlay();
  }

  /**
   * 处理接收到的 fMP4 视频数据
   * @param {ArrayBuffer} data - fMP4 segment 数据
   */
  onVideoData(data) {
    if (this.videoPlayer) {
      if (!this.videoReceived) {
        this.videoReceived = true;
        this._hideWaitingOverlay();
      }
      this.videoPlayer.appendData(data);
    }
  }

  /**
   * 发送控制指令到 Signaling_Server
   * @param {Object} cmd - Control_Command 对象
   */
  sendCommand(cmd) {
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

  /**
   * 绑定 VideoPlayer 实例
   * @param {VideoPlayer} player
   */
  setVideoPlayer(player) {
    this.videoPlayer = player;
  }

  /**
   * 绑定 UI 元素
   * @param {Object} elements - UI 元素引用
   * @param {HTMLElement} elements.statusDot - 状态指示点
   * @param {HTMLElement} elements.statusText - 状态文本
   * @param {HTMLElement} elements.waitingOverlay - 等待覆盖层
   * @param {HTMLElement} elements.reconnectOverlay - 重连覆盖层
   */
  bindUI(elements) {
    this.statusDot = elements.statusDot || null;
    this.statusText = elements.statusText || null;
    this.waitingOverlay = elements.waitingOverlay || null;
    this.reconnectOverlay = elements.reconnectOverlay || null;

    // 绑定手动重连按钮事件
    if (this.reconnectOverlay) {
      const reconnectBtn = this.reconnectOverlay.querySelector('.reconnect-btn');
      if (reconnectBtn) {
        reconnectBtn.addEventListener('click', () => {
          this.retryCount = 0;
          this.hasConnectedBefore = false;
          this.connect();
        });
      }
    }
  }

  // ---- Reconnection Methods ----

  /**
   * 获取重试间隔（毫秒）
   * 独立方法便于测试时 mock
   * @returns {number}
   */
  _getRetryInterval() {
    return this.retryInterval;
  }

  /**
   * 调度重连尝试
   * 如果未达到最大重试次数，则在指定间隔后重试连接
   * 达到最大重试次数后显示"无法连接服务器"提示和手动重连按钮
   */
  _scheduleReconnect() {
    this._cancelReconnect();

    if (this.retryCount >= this.maxRetries) {
      console.log('[RemoteControlClient] Max retries reached (' + this.maxRetries + ')');
      this._showReconnectOverlay();
      return;
    }

    this.retryCount++;
    const interval = this._getRetryInterval();
    console.log('[RemoteControlClient] Scheduling reconnect attempt ' + this.retryCount + '/' + this.maxRetries + ' in ' + interval + 'ms');

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, interval);
  }

  /**
   * 取消待执行的重连定时器
   */
  _cancelReconnect() {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * 显示"无法连接服务器"覆盖层（含手动重连按钮）
   */
  _showReconnectOverlay() {
    if (this.reconnectOverlay) {
      this.reconnectOverlay.classList.remove('hidden');
    }
    // 同时隐藏普通等待覆盖层
    if (this.waitingOverlay) {
      this.waitingOverlay.classList.add('hidden');
    }
  }

  /**
   * 隐藏"无法连接服务器"覆盖层
   */
  _hideReconnectOverlay() {
    if (this.reconnectOverlay) {
      this.reconnectOverlay.classList.add('hidden');
    }
  }

  // ---- Private Methods ----

  /**
   * 处理 WebSocket 消息
   * 二进制消息为 fMP4 视频数据，JSON 消息为控制/状态消息
   * @param {ArrayBuffer|string} data
   */
  _handleMessage(data) {
    if (data instanceof ArrayBuffer) {
      // 二进制消息 → 视频数据
      this.onVideoData(data);
    } else if (typeof data === 'string') {
      // JSON 消息 → 控制/状态消息
      try {
        const msg = JSON.parse(data);
        this._handleJSONMessage(msg);
      } catch (e) {
        console.error('[RemoteControlClient] Invalid JSON message:', e);
      }
    }
  }

  /**
   * 处理 JSON 消息
   * @param {Object} msg
   */
  _handleJSONMessage(msg) {
    switch (msg.type) {
      case 'cmd_result':
        if (this._pendingCommands.has(msg.cmdId)) {
          const { resolve, reject, timer } = this._pendingCommands.get(msg.cmdId);
          clearTimeout(timer);
          this._pendingCommands.delete(msg.cmdId);
          if (msg.ok) {
            resolve(msg);
          } else {
            reject(new Error(msg.error || 'command failed'));
          }
        }
        break;

      case 'session_ready':
        console.log('[RemoteControlClient] Session ready');
        if (this.onSessionReady) this.onSessionReady(msg);
        break;

      case 'session_ended':
        console.log('[RemoteControlClient] Session ended, destroying video player');
        this.videoReceived = false;
        this._showWaitingOverlay();
        // Destroy and reinitialize video player for clean state
        if (this.videoPlayer) {
          this.videoPlayer.destroy();
          this.videoPlayer.init().then(() => {
            console.log('[RemoteControlClient] VideoPlayer reinitialized, ready for new stream');
          }).catch((err) => {
            console.error('[RemoteControlClient] VideoPlayer reinit failed:', err);
          });
        }
        if (this.onSessionEnded) this.onSessionEnded(msg);
        break;

      case 'error':
        console.error('[RemoteControlClient] Server error:', msg.message);
        break;

      default:
        console.log('[RemoteControlClient] Unknown message type:', msg.type);
    }
  }

  /**
   * 发送 JSON 消息
   * @param {Object} obj
   */
  _sendJSON(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    } else {
      console.warn('[RemoteControlClient] Cannot send, WebSocket not open');
    }
  }

  /**
   * 更新连接状态 UI
   * @param {'connected'|'connecting'|'disconnected'} status
   */
  _updateStatus(status) {
    if (this.statusDot) {
      this.statusDot.className = 'status-dot ' + status;
    }
    if (this.statusText) {
      const textMap = {
        connected: '已连接',
        connecting: '连接中...',
        disconnected: '已断开'
      };
      // 达到最大重试次数时显示特殊文本
      if (status === 'disconnected' && this.retryCount >= this.maxRetries) {
        this.statusText.textContent = '无法连接服务器';
      } else {
        this.statusText.textContent = textMap[status] || status;
      }
    }
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }
  }

  /**
   * 显示等待覆盖层
   */
  _showWaitingOverlay() {
    if (this.waitingOverlay) {
      this.waitingOverlay.classList.remove('hidden');
    }
  }

  /**
   * 隐藏等待覆盖层
   */
  _hideWaitingOverlay() {
    if (this.waitingOverlay) {
      this.waitingOverlay.classList.add('hidden');
    }
  }
}


/**
 * CoordinateMapper - Web 坐标到设备坐标的映射
 *
 * 根据 Video 元素显示尺寸与设备分辨率的比例关系转换坐标。
 * 公式：deviceX = clientX × (deviceWidth / displayWidth)
 *       deviceY = clientY × (deviceHeight / displayHeight)
 */
class CoordinateMapper {
  /**
   * @param {number} displayWidth - Video 元素的 CSS 渲染宽度
   * @param {number} displayHeight - Video 元素的 CSS 渲染高度
   * @param {number} deviceWidth - iOS 设备逻辑分辨率宽度（如 393）
   * @param {number} deviceHeight - iOS 设备逻辑分辨率高度（如 852）
   */
  constructor(displayWidth, displayHeight, deviceWidth, deviceHeight) {
    this.displayWidth = displayWidth;
    this.displayHeight = displayHeight;
    this.deviceWidth = deviceWidth;
    this.deviceHeight = deviceHeight;
  }

  /**
   * 将 Web 端坐标转换为设备坐标
   * @param {number} clientX - 鼠标在 Video 元素内的 X 坐标
   * @param {number} clientY - 鼠标在 Video 元素内的 Y 坐标
   * @returns {{ x: number, y: number }} 设备坐标
   */
  mapToDevice(clientX, clientY) {
    const x = clientX * (this.deviceWidth / this.displayWidth);
    const y = clientY * (this.deviceHeight / this.displayHeight);
    return { x, y };
  }
}


/**
 * InteractionHandler - 交互捕获与控制指令生成
 *
 * 监听设备屏幕元素上的鼠标事件，区分 tap（点击）和 swipe（滑动），
 * 使用 CoordinateMapper 转换坐标后通过 RemoteControlClient 发送 Control_Command。
 *
 * 区分逻辑：如果 mousedown 到 mouseup 期间鼠标移动超过阈值（5px），视为 swipe；否则视为 tap。
 * swipe 的 duration 为 mousedown 到 mouseup 的时间（秒），若过短则默认 0.5 秒。
 */
class InteractionHandler {
  /**
   * @param {HTMLElement} screenElement - 设备屏幕 DOM 元素（事件监听目标）
   * @param {RemoteControlClient} client - WebSocket 客户端，用于发送指令
   * @param {Object} deviceResolution - 设备分辨率
   * @param {number} deviceResolution.width - 设备逻辑宽度（如 393）
   * @param {number} deviceResolution.height - 设备逻辑高度（如 852）
   */
  constructor(screenElement, client, deviceResolution) {
    this.screenElement = screenElement;
    this.client = client;
    this.deviceWidth = deviceResolution.width;
    this.deviceHeight = deviceResolution.height;

    /** @type {number} 区分 tap 和 swipe 的移动阈值（像素） */
    this.moveThreshold = 5;

    /** @type {number} swipe 最小 duration（秒） */
    this.minSwipeDuration = 0.1;

    // 鼠标按下状态追踪
    this._isPressed = false;
    this._startX = 0;
    this._startY = 0;
    this._currentX = 0;
    this._currentY = 0;
    this._startTime = 0;

    // 绑定事件处理器（保留引用以便移除）
    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onContextMenu = this._handleContextMenu.bind(this);

    this._bindEvents();
  }

  /**
   * 绑定鼠标事件监听
   */
  _bindEvents() {
    this.screenElement.addEventListener('mousedown', this._onMouseDown);
    this.screenElement.addEventListener('mousemove', this._onMouseMove);
    this.screenElement.addEventListener('mouseup', this._onMouseUp);
    // 防止右键菜单干扰
    this.screenElement.addEventListener('contextmenu', this._onContextMenu);
    // mouseup 可能在元素外触发（拖拽出屏幕区域）
    document.addEventListener('mouseup', this._onMouseUp);
  }

  /**
   * 移除事件监听，释放资源
   */
  destroy() {
    this.screenElement.removeEventListener('mousedown', this._onMouseDown);
    this.screenElement.removeEventListener('mousemove', this._onMouseMove);
    this.screenElement.removeEventListener('mouseup', this._onMouseUp);
    this.screenElement.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('mouseup', this._onMouseUp);
  }

  /**
   * 获取鼠标相对于视频实际渲染区域的归一化坐标 (0-1)
   * 考虑 object-fit: contain 导致的黑边
   * @param {MouseEvent} event
   * @returns {{ x: number, y: number } | null} 归一化坐标，如果点击在黑边区域返回 null
   */
  _getNormalizedPosition(event) {
    const video = this.screenElement.querySelector('video');
    const rect = this.screenElement.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;

    if (!video || !video.videoWidth || !video.videoHeight) {
      // 没有视频，直接用元素尺寸
      return { x: clickX / rect.width, y: clickY / rect.height };
    }

    // 计算 object-fit: contain 下视频的实际渲染区域
    const videoAspect = video.videoWidth / video.videoHeight;
    const containerAspect = rect.width / rect.height;

    let renderWidth, renderHeight, offsetX, offsetY;

    if (videoAspect > containerAspect) {
      // 视频更宽，上下有黑边
      renderWidth = rect.width;
      renderHeight = rect.width / videoAspect;
      offsetX = 0;
      offsetY = (rect.height - renderHeight) / 2;
    } else {
      // 视频更高，左右有黑边
      renderHeight = rect.height;
      renderWidth = rect.height * videoAspect;
      offsetX = (rect.width - renderWidth) / 2;
      offsetY = 0;
    }

    // 检查是否点击在视频渲染区域内
    const videoX = clickX - offsetX;
    const videoY = clickY - offsetY;

    if (videoX < 0 || videoX > renderWidth || videoY < 0 || videoY > renderHeight) {
      return null; // 点击在黑边
    }

    return {
      x: videoX / renderWidth,
      y: videoY / renderHeight,
    };
  }

  /**
   * 创建当前屏幕尺寸对应的 CoordinateMapper
   * @returns {CoordinateMapper}
   */
  _createMapper() {
    const rect = this.screenElement.getBoundingClientRect();
    return new CoordinateMapper(rect.width, rect.height, this.deviceWidth, this.deviceHeight);
  }

  /**
   * 处理 mousedown 事件
   * @param {MouseEvent} event
   */
  _handleMouseDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();

    const pos = this._getNormalizedPosition(event);
    if (!pos) return; // clicked on black bar

    this._isPressed = true;
    this._startX = pos.x;
    this._startY = pos.y;
    this._currentX = pos.x;
    this._currentY = pos.y;
    this._startTime = Date.now();
  }

  _handleMouseMove(event) {
    if (!this._isPressed) return;
    const pos = this._getNormalizedPosition(event);
    if (pos) {
      this._currentX = pos.x;
      this._currentY = pos.y;
    }
  }

  _handleMouseUp(event) {
    if (!this._isPressed) return;
    if (event.button !== 0) return;
    this._isPressed = false;

    const endPos = this._getNormalizedPosition(event);
    if (endPos) {
      this._currentX = endPos.x;
      this._currentY = endPos.y;
    }

    const dx = this._currentX - this._startX;
    const dy = this._currentY - this._startY;
    // threshold in normalized space (~1% of screen)
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > 0.02) {
      let duration = (Date.now() - this._startTime) / 1000;
      if (duration < this.minSwipeDuration) duration = this.minSwipeDuration;

      const cmd = {
        type: 'swipe',
        startX: this._startX,
        startY: this._startY,
        endX: this._currentX,
        endY: this._currentY,
        normalized: true,
        duration: duration
      };
      console.log('[InteractionHandler] Swipe:', cmd);
      this.client.sendCommand(cmd);
    } else {
      const cmd = {
        type: 'tap',
        x: this._startX,
        y: this._startY,
        normalized: true,
      };
      console.log('[InteractionHandler] Tap:', cmd);
      this.client.sendCommand(cmd);
    }
  }

  /**
   * 阻止右键菜单
   * @param {MouseEvent} event
   */
  _handleContextMenu(event) {
    event.preventDefault();
  }
}


// ============================================================
// 页面初始化 - 页面加载后自动连接
// ============================================================
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const videoElement = document.getElementById('videoPlayer');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const waitingOverlay = document.getElementById('waitingOverlay');
    const reconnectOverlay = document.getElementById('reconnectOverlay');

    // 创建 VideoPlayer
    const videoPlayer = new VideoPlayer(videoElement);

    // 创建 RemoteControlClient
    const client = new RemoteControlClient();

    // 绑定 UI 元素
    client.bindUI({ statusDot, statusText, waitingOverlay, reconnectOverlay });

    // 绑定 VideoPlayer
    client.setVideoPlayer(videoPlayer);

    // 初始化 MSE 并连接
    videoPlayer.init().then(() => {
      console.log('[App] VideoPlayer initialized');
      client.connect();
    }).catch((err) => {
      console.error('[App] VideoPlayer init failed:', err);
      // 即使 MSE 初始化失败也尝试连接（可能在不支持 MSE 的环境）
      client.connect();
    });

    // 初始化交互捕获
    const deviceScreen = document.getElementById('deviceScreen');
    const deviceResolution = { width: 393, height: 852 }; // iPhone 16 Pro
    const interactionHandler = new InteractionHandler(deviceScreen, client, deviceResolution);

    // 音量控制按钮事件绑定
    const volumeUpBtn = document.getElementById('volumeUpBtn');
    const volumeDownBtn = document.getElementById('volumeDownBtn');

    if (volumeUpBtn) {
      volumeUpBtn.addEventListener('click', () => {
        client.sendCommand({ type: 'volume_up' });
        console.log('[App] Volume up command sent');
      });
    }

    if (volumeDownBtn) {
      volumeDownBtn.addEventListener('click', () => {
        client.sendCommand({ type: 'volume_down' });
        console.log('[App] Volume down command sent');
      });
    }

    const homeBtn = document.getElementById('homeBtn');
    if (homeBtn) {
      homeBtn.addEventListener('click', () => {
        client.sendCommand({ type: 'home' });
        console.log('[App] Home command sent');
      });
    }

    const screenshotBtn = document.getElementById('screenshotBtn');
    if (screenshotBtn) {
      screenshotBtn.addEventListener('click', async () => {
        console.log('[App] Taking screenshot...');
        try {
          const resp = await fetch('http://localhost:8200/screenshot');
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          // 在新标签页打开截图
          window.open(url, '_blank');
          console.log('[App] Screenshot opened in new tab');
        } catch (err) {
          console.error('[App] Screenshot failed:', err.message);
          alert('截图失败: ' + err.message + '\n确保 XCUITest agent 正在运行 (iproxy 8200 8200)');
        }
      });
    }

    // 输入测试按钮
    const inputBtn = document.getElementById('inputBtn');
    if (inputBtn) {
      inputBtn.addEventListener('click', () => {
        const text = prompt('输入要发送的文本:');
        if (text) {
          client.sendCommand({ type: 'input', text: text });
          console.log('[App] Input command sent:', text);
        }
      });
    }

    // 暴露到全局以便调试和其他模块使用
    window.remoteControlClient = client;
    window.videoPlayer = videoPlayer;
    window.interactionHandler = interactionHandler;

    // ============================================================
    // LLM 对话控制模块初始化
    // ============================================================

    // 获取对话面板容器
    const chatPanelContainer = document.getElementById('chatPanelContainer');

    if (chatPanelContainer) {
      // 创建 ChatPanel 实例
      const chatPanel = new ChatPanel(chatPanelContainer);

      // 创建 LLMClient 实例（构造函数已自动调用 initSystemPrompt）
      const llmClient = new LLMClient();

      // API 请求指向 Node.js server（与 WebSocket 同端口）
      const wsUrl = client.serverUrl; // 'ws://localhost:8080'
      llmClient.apiBase = wsUrl.replace(/^ws/, 'http').replace(/\/$/, '');

      // 创建 ReACTExecutor 实例，注入依赖
      const reactExecutor = new ReACTExecutor(llmClient, chatPanel, client);

      // 注册 ChatPanel 的 onSubmit 回调
      chatPanel.onSubmit((text) => {
        chatPanel.appendUserMessage(text);
        reactExecutor.handleUserMessage(text);
      });

      // 注册配置变更回调
      chatPanel.onConfigChange((config) => {
        llmClient.updateConfig(config);
      });

      // 页面加载时自动应用已保存的配置
      const savedConfig = chatPanel.getConfig();
      if (savedConfig.baseURL || savedConfig.apiKey || savedConfig.model) {
        llmClient.updateConfig(savedConfig);
      }

      // 清除对话按钮
      const clearChatBtn = document.getElementById('clearChatBtn');
      if (clearChatBtn) {
        clearChatBtn.addEventListener('click', () => {
          llmClient.clearHistory();
          chatPanel.clearMessages();
        });
      }

      // 暴露到全局以便调试
      window.chatPanel = chatPanel;
      window.llmClient = llmClient;
      window.reactExecutor = reactExecutor;
    }
  });
}


// ============================================================
// 模块导出 - 支持 Node.js 测试环境
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RemoteControlClient, VideoPlayer, CoordinateMapper, InteractionHandler };
}
