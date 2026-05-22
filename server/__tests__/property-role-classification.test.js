/**
 * **Feature: ios-remote-control, Property 4: 连接角色分类正确性**
 *
 * **Validates: Requirements 6.2**
 *
 * Property: For any valid registration message (role being "device", "viewer",
 * or "controller"), the Signaling_Server should correctly classify the connection
 * into the corresponding role category after parsing the registration message.
 */

const fc = require('fast-check');
const SessionManager = require('../SessionManager');

// Helper to create a mock WebSocket
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

// Arbitrary for valid roles
const validRoleArb = fc.constantFrom('device', 'viewer', 'controller');

describe('Feature: ios-remote-control, Property 4: 连接角色分类正确性', () => {
  it('valid roles should be correctly classified by SessionManager', () => {
    fc.assert(
      fc.property(
        validRoleArb,
        (role) => {
          // Setup fresh instance for each iteration
          const sessionManager = new SessionManager();

          // Create a mock WebSocket connection
          const ws = createMockWs();

          // Register the connection with the given role
          sessionManager.registerConnection(ws, role);

          // Verify getRoleByWs returns the correct role
          const classifiedRole = sessionManager.getRoleByWs(ws);
          expect(classifiedRole).toBe(role);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('invalid roles should be rejected (getRoleByWs returns null)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter(
          (s) => !['device', 'viewer', 'controller'].includes(s)
        ),
        (invalidRole) => {
          const sessionManager = new SessionManager();
          const ws = createMockWs();

          // Attempt to register with an invalid role
          const result = sessionManager.registerConnection(ws, invalidRole);

          // registerConnection should return { error: 'invalid_role' } for invalid roles
          expect(result).toEqual({ error: 'invalid_role' });

          // getRoleByWs should return null for unregistered connections
          const classifiedRole = sessionManager.getRoleByWs(ws);
          expect(classifiedRole).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('multiple connections with different roles should each be classified correctly', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(validRoleArb, fc.constant(null)),
          { minLength: 2, maxLength: 10 }
        ),
        (roleEntries) => {
          const sessionManager = new SessionManager();

          // Create unique WebSocket connections for each entry
          const wsConnections = roleEntries.map(([role]) => {
            const ws = createMockWs();
            sessionManager.registerConnection(ws, role);
            return { ws, role };
          });

          // Verify each connection is classified with the correct role
          for (const { ws, role } of wsConnections) {
            expect(sessionManager.getRoleByWs(ws)).toBe(role);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('registering the same role multiple times should classify each connection correctly', () => {
    fc.assert(
      fc.property(
        validRoleArb,
        fc.integer({ min: 2, max: 5 }),
        (role, count) => {
          const sessionManager = new SessionManager();

          const connections = [];
          for (let i = 0; i < count; i++) {
            const ws = createMockWs();
            sessionManager.registerConnection(ws, role);
            connections.push(ws);
          }

          // Each connection should be classified with the correct role
          for (const ws of connections) {
            expect(sessionManager.getRoleByWs(ws)).toBe(role);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
