const MessageRouter = require('../MessageRouter');

// Helper to create a mock WebSocket
function createMockWs(readyState = 1) {
  return {
    readyState,
    send: jest.fn(),
    close: jest.fn(),
  };
}

// Helper to build a fake ftyp init segment
function buildFakeInitSegment() {
  // ftyp box: [4-byte size][4-byte "ftyp"][...payload]
  const size = 20; // arbitrary small box
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(size, 0);
  buf.write('ftyp', 4, 4, 'ascii');
  buf.write('isom', 8, 4, 'ascii'); // major brand
  return buf;
}

// Helper to build a fake media segment (moof box)
function buildFakeMediaSegment() {
  const size = 16;
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(size, 0);
  buf.write('moof', 4, 4, 'ascii');
  return buf;
}

describe('MessageRouter', () => {
  let router;

  beforeEach(() => {
    router = new MessageRouter();
  });

  describe('isBinary', () => {
    it('should return true for Buffer', () => {
      expect(router.isBinary(Buffer.from([0x00, 0x01]))).toBe(true);
    });

    it('should return true for Uint8Array', () => {
      expect(router.isBinary(new Uint8Array([0x00, 0x01]))).toBe(true);
    });

    it('should return true for ArrayBuffer', () => {
      expect(router.isBinary(new ArrayBuffer(4))).toBe(true);
    });

    it('should return false for string', () => {
      expect(router.isBinary('hello')).toBe(false);
    });

    it('should return false for object', () => {
      expect(router.isBinary({ type: 'tap' })).toBe(false);
    });

    it('should return false for null', () => {
      expect(router.isBinary(null)).toBe(false);
    });
  });

  describe('isInitSegment', () => {
    it('should detect ftyp box as init segment', () => {
      const initSeg = buildFakeInitSegment();
      expect(router.isInitSegment(initSeg)).toBe(true);
    });

    it('should not detect moof box as init segment', () => {
      const mediaSeg = buildFakeMediaSegment();
      expect(router.isInitSegment(mediaSeg)).toBe(false);
    });

    it('should return false for data too short', () => {
      const shortBuf = Buffer.from([0x00, 0x01, 0x02]);
      expect(router.isInitSegment(shortBuf)).toBe(false);
    });

    it('should return false for empty buffer', () => {
      expect(router.isInitSegment(Buffer.alloc(0))).toBe(false);
    });

    it('should work with Uint8Array input', () => {
      const initSeg = buildFakeInitSegment();
      const uint8 = new Uint8Array(initSeg);
      expect(router.isInitSegment(uint8)).toBe(true);
    });
  });

  describe('init segment caching', () => {
    it('should cache and retrieve init segment', () => {
      const initSeg = buildFakeInitSegment();
      router.cacheInitSegment('session-1', initSeg);

      const cached = router.getCachedInitSegment('session-1');
      expect(cached).not.toBeNull();
      expect(cached.equals(initSeg)).toBe(true);
    });

    it('should return null for uncached session', () => {
      expect(router.getCachedInitSegment('nonexistent')).toBeNull();
    });

    it('should overwrite previous init segment on re-cache', () => {
      const initSeg1 = buildFakeInitSegment();
      const initSeg2 = Buffer.alloc(24);
      initSeg2.writeUInt32BE(24, 0);
      initSeg2.write('ftyp', 4, 4, 'ascii');
      initSeg2.write('mp42', 8, 4, 'ascii');

      router.cacheInitSegment('session-1', initSeg1);
      router.cacheInitSegment('session-1', initSeg2);

      const cached = router.getCachedInitSegment('session-1');
      expect(cached.equals(initSeg2)).toBe(true);
    });

    it('should clear init segment cache', () => {
      const initSeg = buildFakeInitSegment();
      router.cacheInitSegment('session-1', initSeg);
      router.clearInitSegmentCache('session-1');

      expect(router.getCachedInitSegment('session-1')).toBeNull();
    });

    it('should not throw when clearing non-existent cache', () => {
      expect(() => router.clearInitSegmentCache('nonexistent')).not.toThrow();
    });
  });

  describe('replayInitSegment', () => {
    it('should send cached init segment to viewer', () => {
      const viewer = createMockWs();
      const initSeg = buildFakeInitSegment();
      router.cacheInitSegment('session-1', initSeg);

      const result = router.replayInitSegment('session-1', viewer);

      expect(result).toBe(true);
      expect(viewer.send).toHaveBeenCalledWith(initSeg);
    });

    it('should return false if no cached init segment', () => {
      const viewer = createMockWs();
      const result = router.replayInitSegment('session-1', viewer);

      expect(result).toBe(false);
      expect(viewer.send).not.toHaveBeenCalled();
    });

    it('should return false if viewer is not open', () => {
      const viewer = createMockWs(3); // CLOSED
      const initSeg = buildFakeInitSegment();
      router.cacheInitSegment('session-1', initSeg);

      const result = router.replayInitSegment('session-1', viewer);

      expect(result).toBe(false);
      expect(viewer.send).not.toHaveBeenCalled();
    });

    it('should return false if viewer is null', () => {
      const initSeg = buildFakeInitSegment();
      router.cacheInitSegment('session-1', initSeg);

      const result = router.replayInitSegment('session-1', null);
      expect(result).toBe(false);
    });
  });

  describe('route', () => {
    let device, viewer, controller, session;

    beforeEach(() => {
      device = createMockWs();
      viewer = createMockWs();
      controller = createMockWs();
      session = {
        sessionId: 'test-session-id',
        device,
        viewers: [viewer],
        controller,
      };
    });

    it('should return false if no session provided', () => {
      const result = router.route(device, Buffer.from([0x00]), 'device', null);
      expect(result).toBe(false);
    });

    describe('device → viewer (binary)', () => {
      it('should forward binary data from device to viewer', () => {
        const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03]);
        const result = router.route(device, binaryData, 'device', session);

        expect(result).toBe(true);
        expect(viewer.send).toHaveBeenCalledWith(binaryData);
        expect(controller.send).not.toHaveBeenCalled();
      });

      it('should cache init segment when forwarding', () => {
        const initSeg = buildFakeInitSegment();
        router.route(device, initSeg, 'device', session);

        const cached = router.getCachedInitSegment('test-session-id');
        expect(cached).not.toBeNull();
        expect(cached.equals(initSeg)).toBe(true);
      });

      it('should not cache media segments', () => {
        const mediaSeg = buildFakeMediaSegment();
        router.route(device, mediaSeg, 'device', session);

        expect(router.getCachedInitSegment('test-session-id')).toBeNull();
      });

      it('should return false if all viewers are not open', () => {
        viewer.readyState = 3; // CLOSED
        const binaryData = Buffer.from([0x00]);
        const result = router.route(device, binaryData, 'device', session);

        expect(result).toBe(false);
        expect(viewer.send).not.toHaveBeenCalled();
      });

      it('should return false for non-binary device messages', () => {
        const jsonStr = JSON.stringify({ type: 'info' });
        const result = router.route(device, jsonStr, 'device', session);

        expect(result).toBe(false);
      });
    });

    describe('viewer → controller (JSON)', () => {
      it('should forward JSON message from viewer to controller', () => {
        const jsonMsg = JSON.stringify({ type: 'tap', x: 100, y: 200 });
        const result = router.route(viewer, jsonMsg, 'viewer', session);

        expect(result).toBe(true);
        expect(controller.send).toHaveBeenCalledWith(jsonMsg);
        expect(device.send).not.toHaveBeenCalled();
      });

      it('should forward binary data from viewer to controller', () => {
        // Viewer can also send binary (though unusual), it should still route to controller
        const binaryMsg = Buffer.from([0x01, 0x02]);
        const result = router.route(viewer, binaryMsg, 'viewer', session);

        expect(result).toBe(true);
        expect(controller.send).toHaveBeenCalledWith(binaryMsg);
        expect(device.send).not.toHaveBeenCalled();
      });

      it('should return false if controller is not open', () => {
        controller.readyState = 3; // CLOSED
        const jsonMsg = JSON.stringify({ type: 'tap', x: 100, y: 200 });
        const result = router.route(viewer, jsonMsg, 'viewer', session);

        expect(result).toBe(false);
        expect(controller.send).not.toHaveBeenCalled();
      });
    });

    describe('controller → viewer (status feedback)', () => {
      it('should forward status message from controller to viewer', () => {
        const statusMsg = JSON.stringify({ type: 'status', result: 'ok' });
        const result = router.route(controller, statusMsg, 'controller', session);

        expect(result).toBe(true);
        expect(viewer.send).toHaveBeenCalledWith(statusMsg);
        expect(device.send).not.toHaveBeenCalled();
      });

      it('should return false if all viewers are not open', () => {
        viewer.readyState = 3; // CLOSED
        const statusMsg = JSON.stringify({ type: 'status', result: 'ok' });
        const result = router.route(controller, statusMsg, 'controller', session);

        expect(result).toBe(false);
        expect(viewer.send).not.toHaveBeenCalled();
      });
    });

    it('should return false for unknown role', () => {
      const result = router.route(device, 'test', 'unknown', session);
      expect(result).toBe(false);
    });
  });
});
