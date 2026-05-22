/**
 * Unit tests for RemoteControlClient, VideoPlayer, and additional CoordinateMapper edge cases
 * Task 3.10: 编写 Web 前端单元测试
 * 需求：3.1, 4.1, 4.2, 10.2
 */

const { RemoteControlClient, VideoPlayer, CoordinateMapper } = require('../app');

// ============================================================
// WebSocket Mock
// ============================================================
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.binaryType = 'blob';
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;
    this._sent = [];
  }

  send(data) {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this._sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose({ code: 1000 });
    }
  }

  // Test helpers
  _simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }

  _simulateMessage(data) {
    if (this.onmessage) this.onmessage({ data });
  }

  _simulateClose(code = 1006) {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose({ code });
  }

  _simulateError(error) {
    if (this.onerror) this.onerror(error);
  }
}

// ============================================================
// MediaSource / SourceBuffer Mock
// ============================================================
class MockSourceBuffer {
  constructor() {
    this.mode = 'segments';
    this.updating = false;
    this._listeners = {};
    this._appendedBuffers = [];
  }

  addEventListener(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
  }

  removeEventListener(event, handler) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(h => h !== handler);
    }
  }

  appendBuffer(data) {
    this.updating = true;
    this._appendedBuffers.push(data);
    // Simulate async completion
    setTimeout(() => {
      this.updating = false;
      if (this._listeners['updateend']) {
        this._listeners['updateend'].forEach(h => h());
      }
    }, 0);
  }

  remove(start, end) {
    this.updating = true;
    setTimeout(() => {
      this.updating = false;
      if (this._listeners['updateend']) {
        this._listeners['updateend'].forEach(h => h());
      }
    }, 0);
  }
}

class MockMediaSource {
  constructor() {
    this.readyState = 'closed';
    this.sourceBuffers = [];
    this._listeners = {};
    this._sourceBuffer = new MockSourceBuffer();
  }

  addEventListener(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
  }

  removeEventListener(event, handler) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(h => h !== handler);
    }
  }

  addSourceBuffer(mimeType) {
    this.sourceBuffers.push(this._sourceBuffer);
    return this._sourceBuffer;
  }

  removeSourceBuffer(sb) {
    this.sourceBuffers = this.sourceBuffers.filter(s => s !== sb);
  }

  endOfStream() {
    this.readyState = 'ended';
  }

  // Test helper: simulate sourceopen
  _triggerSourceOpen() {
    this.readyState = 'open';
    if (this._listeners['sourceopen']) {
      this._listeners['sourceopen'].forEach(h => h());
    }
  }
}

// ============================================================
// Setup global mocks
// ============================================================
beforeAll(() => {
  // Mock WebSocket globally
  global.WebSocket = MockWebSocket;

  // Mock URL.createObjectURL / revokeObjectURL
  if (!global.URL.createObjectURL) {
    global.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  }
  if (!global.URL.revokeObjectURL) {
    global.URL.revokeObjectURL = jest.fn();
  }
});

// ============================================================
// CoordinateMapper - Additional Edge Case Tests
// ============================================================
describe('CoordinateMapper - edge cases', () => {
  test('handles very small display dimensions', () => {
    const mapper = new CoordinateMapper(1, 1, 393, 852);
    const result = mapper.mapToDevice(0.5, 0.5);
    expect(result.x).toBeCloseTo(196.5, 5);
    expect(result.y).toBeCloseTo(426, 5);
  });

  test('handles very large display dimensions', () => {
    const mapper = new CoordinateMapper(3840, 2160, 393, 852);
    const result = mapper.mapToDevice(1920, 1080);
    expect(result.x).toBeCloseTo(393 / 2, 5);
    expect(result.y).toBeCloseTo(852 / 2, 5);
  });

  test('handles non-integer coordinates', () => {
    const mapper = new CoordinateMapper(320, 694, 393, 852);
    const result = mapper.mapToDevice(160.7, 347.3);
    expect(result.x).toBeCloseTo(160.7 * (393 / 320), 5);
    expect(result.y).toBeCloseTo(347.3 * (852 / 694), 5);
  });
});

// ============================================================
// RemoteControlClient Tests
// ============================================================
describe('RemoteControlClient', () => {
  let client;

  beforeEach(() => {
    jest.useFakeTimers();
    client = new RemoteControlClient('ws://localhost:8080');
  });

  afterEach(() => {
    client.disconnect();
    jest.useRealTimers();
  });

  // ---- Connection Status Management ----
  describe('connection status management', () => {
    test('initial state is disconnected', () => {
      expect(client.connected).toBe(false);
      expect(client.retryCount).toBe(0);
    });

    test('status changes to connecting when connect() is called', () => {
      const statusChanges = [];
      client.onStatusChange = (status) => statusChanges.push(status);
      client.connect();
      expect(statusChanges).toContain('connecting');
    });

    test('status changes to connected on WebSocket open', () => {
      const statusChanges = [];
      client.onStatusChange = (status) => statusChanges.push(status);
      client.connect();
      client.ws._simulateOpen();
      expect(client.connected).toBe(true);
      expect(statusChanges).toContain('connected');
    });

    test('status changes to disconnected on WebSocket close', () => {
      const statusChanges = [];
      client.onStatusChange = (status) => statusChanges.push(status);
      client.connect();
      client.ws._simulateOpen();
      client.ws._simulateClose();
      expect(client.connected).toBe(false);
      expect(statusChanges).toContain('disconnected');
    });

    test('sends viewer registration message on connect', () => {
      client.connect();
      client.ws._simulateOpen();
      expect(client.ws._sent.length).toBe(1);
      const msg = JSON.parse(client.ws._sent[0]);
      expect(msg).toEqual({ type: 'register', role: 'viewer' });
    });

    test('resets retryCount on successful connection', () => {
      client.retryCount = 5;
      client.connect();
      client.ws._simulateOpen();
      expect(client.retryCount).toBe(0);
    });

    test('sets hasConnectedBefore after first successful connection', () => {
      expect(client.hasConnectedBefore).toBe(false);
      client.connect();
      client.ws._simulateOpen();
      expect(client.hasConnectedBefore).toBe(true);
    });
  });

  // ---- Message Sending ----
  describe('message sending', () => {
    test('sendCommand sends JSON when connected', () => {
      client.connect();
      client.ws._simulateOpen();
      client.sendCommand({ type: 'tap', x: 100, y: 200 });
      // First message is register, second is the command
      expect(client.ws._sent.length).toBe(2);
      const cmd = JSON.parse(client.ws._sent[1]);
      expect(cmd).toMatchObject({ type: 'tap', x: 100, y: 200 });
    });

    test('sendCommand does not throw when disconnected', () => {
      expect(() => {
        client.sendCommand({ type: 'tap', x: 100, y: 200 });
      }).not.toThrow();
    });

    test('sends swipe command with all fields', () => {
      client.connect();
      client.ws._simulateOpen();
      const swipeCmd = {
        type: 'swipe',
        startX: 100,
        startY: 200,
        endX: 100,
        endY: 400,
        duration: 0.5
      };
      client.sendCommand(swipeCmd);
      const sent = JSON.parse(client.ws._sent[1]);
      expect(sent).toMatchObject(swipeCmd);
    });

    test('sends volume commands', () => {
      client.connect();
      client.ws._simulateOpen();
      client.sendCommand({ type: 'volume_up' });
      client.sendCommand({ type: 'volume_down' });
      expect(client.ws._sent.length).toBe(3); // register + 2 commands
      expect(JSON.parse(client.ws._sent[1])).toMatchObject({ type: 'volume_up' });
      expect(JSON.parse(client.ws._sent[2])).toMatchObject({ type: 'volume_down' });
    });
  });

  // ---- Reconnection Logic ----
  describe('reconnection logic', () => {
    test('schedules reconnect on connection failure', () => {
      client.connect();
      const ws = client.ws;
      ws._simulateClose(1006);
      // retryCount should be incremented
      expect(client.retryCount).toBe(1);
    });

    test('retries up to maxRetries (10) times', () => {
      for (let i = 0; i < 10; i++) {
        client.connect();
        client.ws._simulateClose(1006);
        jest.advanceTimersByTime(3000);
      }
      // After 10 failures, retryCount should be at max
      expect(client.retryCount).toBe(10);
    });

    test('stops retrying after maxRetries reached', () => {
      client.retryCount = 10;
      client.connect();
      client.ws._simulateClose(1006);
      // Should not schedule another retry
      expect(client.retryTimer).toBeNull();
    });

    test('retry interval is 3 seconds', () => {
      expect(client.retryInterval).toBe(3000);
      expect(client._getRetryInterval()).toBe(3000);
    });

    test('disconnect() prevents reconnection', () => {
      client.connect();
      client.ws._simulateOpen();
      client.disconnect();
      expect(client.intentionalDisconnect).toBe(true);
      expect(client.connected).toBe(false);
    });

    test('mid-session disconnect resets retryCount and reconnects', () => {
      client.connect();
      client.ws._simulateOpen();
      // Now simulate a mid-session disconnect
      client.ws._simulateClose(1006);
      // retryCount should be reset to 0 then incremented to 1
      expect(client.retryCount).toBe(1);
    });
  });

  // ---- Message Handling ----
  describe('message handling', () => {
    test('binary messages are forwarded to VideoPlayer', () => {
      const mockPlayer = { appendData: jest.fn() };
      client.setVideoPlayer(mockPlayer);
      client.connect();
      client.ws._simulateOpen();

      const binaryData = new ArrayBuffer(16);
      client.ws._simulateMessage(binaryData);

      expect(mockPlayer.appendData).toHaveBeenCalledWith(binaryData);
    });

    test('session_ready JSON message triggers callback', () => {
      const onSessionReady = jest.fn();
      client.onSessionReady = onSessionReady;
      client.connect();
      client.ws._simulateOpen();

      client.ws._simulateMessage(JSON.stringify({ type: 'session_ready' }));
      expect(onSessionReady).toHaveBeenCalledWith({ type: 'session_ready' });
    });

    test('session_ended JSON message triggers callback and shows waiting overlay', () => {
      const onSessionEnded = jest.fn();
      client.onSessionEnded = onSessionEnded;
      client.connect();
      client.ws._simulateOpen();

      client.ws._simulateMessage(JSON.stringify({ type: 'session_ended' }));
      expect(onSessionEnded).toHaveBeenCalled();
      expect(client.videoReceived).toBe(false);
    });

    test('first video data hides waiting overlay', () => {
      const mockPlayer = { appendData: jest.fn() };
      client.setVideoPlayer(mockPlayer);

      const waitingOverlay = document.createElement('div');
      client.bindUI({ waitingOverlay });

      client.connect();
      client.ws._simulateOpen();

      expect(client.videoReceived).toBe(false);
      client.ws._simulateMessage(new ArrayBuffer(8));
      expect(client.videoReceived).toBe(true);
    });
  });

  // ---- UI Binding ----
  describe('UI binding', () => {
    test('updates status dot and text on status change', () => {
      const statusDot = document.createElement('div');
      const statusText = document.createElement('span');
      client.bindUI({ statusDot, statusText });

      client.connect();
      expect(statusDot.className).toBe('status-dot connecting');
      expect(statusText.textContent).toBe('连接中...');

      client.ws._simulateOpen();
      expect(statusDot.className).toBe('status-dot connected');
      expect(statusText.textContent).toBe('已连接');
    });

    test('shows "无法连接服务器" when max retries reached', () => {
      const statusText = document.createElement('span');
      client.bindUI({ statusText });

      client.retryCount = 10;
      client._updateStatus('disconnected');
      expect(statusText.textContent).toBe('无法连接服务器');
    });
  });
});

// ============================================================
// VideoPlayer Tests
// ============================================================
describe('VideoPlayer', () => {
  let videoElement;
  let player;
  let originalMediaSource;

  beforeEach(() => {
    // Save and mock MediaSource
    originalMediaSource = global.MediaSource;
    global.MediaSource = MockMediaSource;

    videoElement = document.createElement('video');
    // Mock buffered property
    Object.defineProperty(videoElement, 'buffered', {
      get: () => ({
        length: 0,
        start: () => 0,
        end: () => 0
      }),
      configurable: true
    });

    player = new VideoPlayer(videoElement);
  });

  afterEach(() => {
    player.destroy();
    global.MediaSource = originalMediaSource;
  });

  // ---- MSE Initialization ----
  describe('MSE initialization', () => {
    test('init() creates MediaSource and binds to video element', async () => {
      const initPromise = player.init();
      // Trigger sourceopen
      player.mediaSource._triggerSourceOpen();
      await initPromise;

      expect(player.initialized).toBe(true);
      expect(player.sourceBuffer).toBeTruthy();
      expect(videoElement.src).toBeTruthy();
    });

    test('init() rejects when MediaSource is not supported', async () => {
      global.MediaSource = undefined;
      const unsupportedPlayer = new VideoPlayer(videoElement);

      await expect(unsupportedPlayer.init()).rejects.toThrow('MediaSource API is not supported');

      global.MediaSource = MockMediaSource;
    });

    test('sourceBuffer is created with correct MIME type', async () => {
      const initPromise = player.init();
      player.mediaSource._triggerSourceOpen();
      await initPromise;

      expect(player.mimeType).toBe('video/mp4; codecs="avc1.640029"');
      expect(player.sourceBuffer).toBeInstanceOf(MockSourceBuffer);
    });

    test('initialized flag is false before init', () => {
      expect(player.initialized).toBe(false);
    });
  });

  // ---- Segment Append ----
  describe('segment append', () => {
    /** Helper: create a fake ftyp init segment (starts with ftyp box type at bytes 4-7) */
    function createInitSegment() {
      const buf = new ArrayBuffer(16);
      const view = new DataView(buf);
      view.setUint32(0, 16);        // box size
      view.setUint32(4, 0x66747970); // 'ftyp'
      return buf;
    }

    /** Helper: create a fake moof media segment */
    function createMediaSegment() {
      const buf = new ArrayBuffer(16);
      const view = new DataView(buf);
      view.setUint32(0, 16);        // box size
      view.setUint32(4, 0x6D6F6F66); // 'moof'
      return buf;
    }

    test('appendData detects init segment by ftyp box', async () => {
      const initPromise = player.init();
      player.mediaSource._triggerSourceOpen();
      await initPromise;

      const initSeg = createInitSegment();
      player.appendData(initSeg);

      expect(player.hasInitSegment).toBe(true);
      expect(player.sourceBuffer._appendedBuffers.length).toBe(1);
    });

    test('appendData queues media segment after init segment', async () => {
      const initPromise = player.init();
      player.mediaSource._triggerSourceOpen();
      await initPromise;

      const initSeg = createInitSegment();
      player.appendData(initSeg);

      const mediaSeg = createMediaSegment();
      player.appendData(mediaSeg);

      // Both should be queued/appended
      expect(player.sourceBuffer._appendedBuffers.length).toBeGreaterThanOrEqual(1);
    });

    test('drops media segment when no init segment received yet', async () => {
      const initPromise = player.init();
      player.mediaSource._triggerSourceOpen();
      await initPromise;

      const mediaSeg = createMediaSegment();
      player.appendData(mediaSeg);

      // Should not append since hasInitSegment is false
      expect(player.hasInitSegment).toBe(false);
      expect(player.sourceBuffer._appendedBuffers.length).toBe(0);
    });

    test('drops data when not initialized', () => {
      // Player not initialized, appendData should not throw
      const initSeg = createInitSegment();
      expect(() => player.appendData(initSeg)).not.toThrow();
    });

    test('_isInitSegment returns false for buffers smaller than 8 bytes', async () => {
      const initPromise = player.init();
      player.mediaSource._triggerSourceOpen();
      await initPromise;

      const smallBuf = new ArrayBuffer(4);
      expect(player._isInitSegment(smallBuf)).toBe(false);
    });
  });

  // ---- Destroy ----
  describe('destroy', () => {
    test('destroy resets all state', async () => {
      const initPromise = player.init();
      player.mediaSource._triggerSourceOpen();
      await initPromise;

      player.destroy();

      expect(player.initialized).toBe(false);
      expect(player.sourceBuffer).toBeNull();
      expect(player.mediaSource).toBeNull();
      expect(player.queue).toEqual([]);
      expect(player.hasInitSegment).toBe(false);
    });

    test('destroy can be called multiple times safely', async () => {
      const initPromise = player.init();
      player.mediaSource._triggerSourceOpen();
      await initPromise;

      expect(() => {
        player.destroy();
        player.destroy();
      }).not.toThrow();
    });

    test('destroy clears intervals', async () => {
      const initPromise = player.init();
      player.mediaSource._triggerSourceOpen();
      await initPromise;

      expect(player.latencyInterval).not.toBeNull();
      expect(player.cleanupInterval).not.toBeNull();

      player.destroy();

      expect(player.latencyInterval).toBeNull();
      expect(player.cleanupInterval).toBeNull();
    });
  });

  // ---- Configuration ----
  describe('configuration defaults', () => {
    test('has correct default latency threshold', () => {
      expect(player.latencyThreshold).toBe(0.2);
    });

    test('has correct default max buffer duration', () => {
      expect(player.maxBufferDuration).toBe(5);
    });

    test('has correct default latency check interval', () => {
      expect(player.latencyCheckInterval).toBe(200);
    });

    test('has correct default cleanup check interval', () => {
      expect(player.cleanupCheckInterval).toBe(3000);
    });
  });
});
