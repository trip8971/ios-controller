/**
 * **Feature: ios-remote-control, Property 1: 二进制数据转发完整性**
 *
 * **Validates: Requirements 2.2, 6.4**
 *
 * Property: For any arbitrary binary data (simulating Video_Frame), when sent
 * through a device role WebSocket connection to the Signaling_Server, the viewer
 * role connection in the same Session should receive exactly the same binary data
 * (byte-level equality).
 */

const fc = require('fast-check');
const SessionManager = require('../SessionManager');
const MessageRouter = require('../MessageRouter');

// Helper to create a mock WebSocket with message capture
function createMockWs(readyState = 1) {
  const messages = [];
  return {
    readyState,
    send: jest.fn((data) => {
      messages.push(data);
    }),
    close: jest.fn(),
    _receivedMessages: messages,
  };
}

// Helper to create a session with device, viewer, and controller
function createTestSession(sessionManager) {
  const deviceWs = createMockWs();
  const viewerWs = createMockWs();
  const controllerWs = createMockWs();

  const session = sessionManager.createSession(deviceWs, controllerWs);
  session.viewers.push(viewerWs);
  sessionManager.wsRoleMap.set(viewerWs, 'viewer');

  return { deviceWs, viewerWs, controllerWs, session };
}

describe('Feature: ios-remote-control, Property 1: 二进制数据转发完整性', () => {
  it('binary data sent by device should be received by viewer with byte-level equality', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 10000 }),
        (binaryData) => {
          // Setup fresh instances for each iteration
          const sessionManager = new SessionManager();
          const messageRouter = new MessageRouter();

          const { deviceWs, viewerWs, controllerWs, session } = createTestSession(sessionManager);

          // Convert the arbitrary Uint8Array to a Buffer (as the server receives)
          const dataBuffer = Buffer.from(binaryData);

          // Route binary data from device through MessageRouter
          const role = 'device';
          const routed = messageRouter.route(deviceWs, dataBuffer, role, session);

          // Verify routing succeeded
          expect(routed).toBe(true);

          // Verify viewer received exactly one message
          expect(viewerWs.send).toHaveBeenCalledTimes(1);

          // Get the data that was sent to the viewer
          const receivedData = viewerWs._receivedMessages[0];

          // Verify byte-level equality
          const receivedBuffer = Buffer.isBuffer(receivedData)
            ? receivedData
            : Buffer.from(receivedData);

          expect(receivedBuffer.length).toBe(dataBuffer.length);
          expect(receivedBuffer.equals(dataBuffer)).toBe(true);

          // Verify controller did NOT receive the binary data
          expect(controllerWs.send).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('empty binary data should also be forwarded with integrity', () => {
    // Edge case: empty buffers should still route correctly
    const sessionManager = new SessionManager();
    const messageRouter = new MessageRouter();

    const { deviceWs, viewerWs, controllerWs, session } = createTestSession(sessionManager);

    const emptyBuffer = Buffer.alloc(0);
    const routed = messageRouter.route(deviceWs, emptyBuffer, 'device', session);

    // Empty buffer is still binary, should be forwarded
    expect(routed).toBe(true);
    expect(viewerWs.send).toHaveBeenCalledTimes(1);
    expect(viewerWs._receivedMessages[0].length).toBe(0);
  });

  it('multiple sequential binary messages should each maintain integrity', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ minLength: 1, maxLength: 5000 }), { minLength: 2, maxLength: 10 }),
        (binaryMessages) => {
          const sessionManager = new SessionManager();
          const messageRouter = new MessageRouter();

          const { deviceWs, viewerWs, controllerWs, session } = createTestSession(sessionManager);

          // Send all binary messages from device
          for (const msg of binaryMessages) {
            const dataBuffer = Buffer.from(msg);
            const routed = messageRouter.route(deviceWs, dataBuffer, 'device', session);
            expect(routed).toBe(true);
          }

          // Verify viewer received all messages in order with byte-level equality
          expect(viewerWs.send).toHaveBeenCalledTimes(binaryMessages.length);

          for (let i = 0; i < binaryMessages.length; i++) {
            const sent = Buffer.from(binaryMessages[i]);
            const received = Buffer.isBuffer(viewerWs._receivedMessages[i])
              ? viewerWs._receivedMessages[i]
              : Buffer.from(viewerWs._receivedMessages[i]);

            expect(received.length).toBe(sent.length);
            expect(received.equals(sent)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
