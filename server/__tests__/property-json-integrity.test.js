/**
 * **Feature: ios-remote-control, Property 2: JSON 消息转发完整性**
 *
 * **Validates: Requirements 4.4, 6.5**
 *
 * Property: For any valid Control_Command JSON message, when sent through a
 * viewer role WebSocket connection to the Signaling_Server, the controller role
 * connection in the same Session should receive a semantically equivalent JSON
 * message.
 *
 * Control_Command types:
 * - tap: { type: "tap", x: number, y: number }
 * - swipe: { type: "swipe", startX: number, startY: number, endX: number, endY: number, duration?: number }
 * - volume_up: { type: "volume_up" }
 * - volume_down: { type: "volume_down" }
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

// --- fast-check arbitraries for Control_Command types ---

const tapCommandArb = fc.record({
  type: fc.constant('tap'),
  x: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
  y: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
});

const swipeCommandArb = fc.oneof(
  // swipe without optional duration
  fc.record({
    type: fc.constant('swipe'),
    startX: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
    startY: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
    endX: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
    endY: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
  }),
  // swipe with optional duration
  fc.record({
    type: fc.constant('swipe'),
    startX: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
    startY: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
    endX: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
    endY: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
    duration: fc.double({ min: 0.01, max: 10, noNaN: true, noDefaultInfinity: true }),
  })
);

const volumeUpCommandArb = fc.constant({ type: 'volume_up' });

const volumeDownCommandArb = fc.constant({ type: 'volume_down' });

// Combined arbitrary that generates any valid Control_Command
const controlCommandArb = fc.oneof(
  tapCommandArb,
  swipeCommandArb,
  volumeUpCommandArb,
  volumeDownCommandArb
);

describe('Feature: ios-remote-control, Property 2: JSON 消息转发完整性', () => {
  it('Control_Command JSON sent by viewer should be received by controller with semantic equivalence', () => {
    fc.assert(
      fc.property(
        controlCommandArb,
        (command) => {
          // Setup fresh instances for each iteration
          const sessionManager = new SessionManager();
          const messageRouter = new MessageRouter();

          const { deviceWs, viewerWs, controllerWs, session } = createTestSession(sessionManager);

          // Serialize the Control_Command to JSON string (as the viewer would send)
          const jsonString = JSON.stringify(command);

          // Route JSON message from viewer through MessageRouter
          const routed = messageRouter.route(viewerWs, jsonString, 'viewer', session);

          // Verify routing succeeded
          expect(routed).toBe(true);

          // Verify controller received exactly one message
          expect(controllerWs.send).toHaveBeenCalledTimes(1);

          // Get the data that was sent to the controller
          const receivedData = controllerWs._receivedMessages[0];

          // Parse the received JSON and verify semantic equivalence
          const receivedCommand = JSON.parse(receivedData);

          // Verify type field matches
          expect(receivedCommand.type).toBe(command.type);

          // Verify all fields are semantically equivalent
          expect(receivedCommand).toEqual(command);

          // Verify device did NOT receive the JSON message
          expect(deviceWs.send).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('tap commands should preserve x and y coordinates through forwarding', () => {
    fc.assert(
      fc.property(
        tapCommandArb,
        (tapCommand) => {
          const sessionManager = new SessionManager();
          const messageRouter = new MessageRouter();

          const { deviceWs, viewerWs, controllerWs, session } = createTestSession(sessionManager);

          const jsonString = JSON.stringify(tapCommand);
          messageRouter.route(viewerWs, jsonString, 'viewer', session);

          const received = JSON.parse(controllerWs._receivedMessages[0]);

          expect(received.type).toBe('tap');
          expect(received.x).toBe(tapCommand.x);
          expect(received.y).toBe(tapCommand.y);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('swipe commands should preserve all coordinate fields and optional duration through forwarding', () => {
    fc.assert(
      fc.property(
        swipeCommandArb,
        (swipeCommand) => {
          const sessionManager = new SessionManager();
          const messageRouter = new MessageRouter();

          const { deviceWs, viewerWs, controllerWs, session } = createTestSession(sessionManager);

          const jsonString = JSON.stringify(swipeCommand);
          messageRouter.route(viewerWs, jsonString, 'viewer', session);

          const received = JSON.parse(controllerWs._receivedMessages[0]);

          expect(received.type).toBe('swipe');
          expect(received.startX).toBe(swipeCommand.startX);
          expect(received.startY).toBe(swipeCommand.startY);
          expect(received.endX).toBe(swipeCommand.endX);
          expect(received.endY).toBe(swipeCommand.endY);

          // duration is optional — verify it's preserved when present
          if ('duration' in swipeCommand) {
            expect(received.duration).toBe(swipeCommand.duration);
          } else {
            expect(received).not.toHaveProperty('duration');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('volume commands should preserve type field through forwarding', () => {
    fc.assert(
      fc.property(
        fc.oneof(volumeUpCommandArb, volumeDownCommandArb),
        (volumeCommand) => {
          const sessionManager = new SessionManager();
          const messageRouter = new MessageRouter();

          const { deviceWs, viewerWs, controllerWs, session } = createTestSession(sessionManager);

          const jsonString = JSON.stringify(volumeCommand);
          messageRouter.route(viewerWs, jsonString, 'viewer', session);

          const received = JSON.parse(controllerWs._receivedMessages[0]);

          expect(received).toEqual(volumeCommand);
        }
      ),
      { numRuns: 100 }
    );
  });
});
