/**
 * **Feature: ios-remote-control, Property 7: Web_Client 重试逻辑正确性**
 *
 * 属性 7：Web_Client 重试逻辑正确性
 * 对于任意连续连接失败序列（1 到 10 次），Web_Client 的重试机制应以 3 秒为间隔进行重试，
 * 且总重试次数不超过 10 次。当达到最大重试次数后应停止重试。
 *
 * **Validates: Requirements 10.2**
 */

const fc = require('fast-check');
const { RemoteControlClient } = require('../app');

// Mock WebSocket since it doesn't exist in Node.js test environment
class MockWebSocket {
  constructor() {
    this.readyState = 3; // CLOSED
  }
  close() {}
}
MockWebSocket.CONNECTING = 0;
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;

// Set global WebSocket before tests
beforeAll(() => {
  global.WebSocket = MockWebSocket;
});

afterAll(() => {
  delete global.WebSocket;
});

describe('Feature: ios-remote-control, Property 7: Web_Client 重试逻辑正确性', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('retryCount increments correctly for N consecutive failures (1-10)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (failureCount) => {
          const client = new RemoteControlClient('ws://localhost:8080');

          // Mock connect to prevent actual WebSocket creation
          client.connect = jest.fn();

          for (let i = 0; i < failureCount; i++) {
            client._scheduleReconnect();
            // Advance timer to trigger the scheduled reconnect
            jest.advanceTimersByTime(3000);
          }

          expect(client.retryCount).toBe(failureCount);

          // Cleanup
          client._cancelReconnect();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('_getRetryInterval() always returns 3000ms', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (failureCount) => {
          const client = new RemoteControlClient('ws://localhost:8080');

          // Mock connect to prevent actual WebSocket creation
          client.connect = jest.fn();

          // Verify interval is 3000ms at each retry step
          for (let i = 0; i < failureCount; i++) {
            expect(client._getRetryInterval()).toBe(3000);
            client._scheduleReconnect();
            jest.advanceTimersByTime(3000);
          }

          // Cleanup
          client._cancelReconnect();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('stops retrying after maxRetries (10) failures', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (failureCount) => {
          const client = new RemoteControlClient('ws://localhost:8080');

          // Mock connect to prevent actual WebSocket creation
          client.connect = jest.fn();

          // Simulate exactly maxRetries (10) failures
          for (let i = 0; i < client.maxRetries; i++) {
            client._scheduleReconnect();
            jest.advanceTimersByTime(3000);
          }

          expect(client.retryCount).toBe(10);

          // Now calling _scheduleReconnect again should NOT schedule another retry
          // because retryCount >= maxRetries
          client.connect.mockClear();
          client._scheduleReconnect();

          // Advance time well beyond the retry interval
          jest.advanceTimersByTime(10000);

          // connect should NOT have been called since we hit the max
          expect(client.connect).not.toHaveBeenCalled();
          expect(client.retryCount).toBe(10);

          // Cleanup
          client._cancelReconnect();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('retryCount never exceeds maxRetries for any failure sequence length', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (failureCount) => {
          const client = new RemoteControlClient('ws://localhost:8080');

          // Mock connect to prevent actual WebSocket creation
          client.connect = jest.fn();

          // Simulate failureCount + extra attempts beyond maxRetries
          const totalAttempts = failureCount + client.maxRetries;
          for (let i = 0; i < totalAttempts; i++) {
            client._scheduleReconnect();
            jest.advanceTimersByTime(3000);
          }

          // retryCount should never exceed maxRetries
          expect(client.retryCount).toBeLessThanOrEqual(client.maxRetries);

          // Cleanup
          client._cancelReconnect();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('each retry is scheduled with exactly 3000ms interval', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (failureCount) => {
          const client = new RemoteControlClient('ws://localhost:8080');

          // Mock connect to prevent actual WebSocket creation
          client.connect = jest.fn();

          for (let i = 0; i < failureCount; i++) {
            client.connect.mockClear();
            client._scheduleReconnect();

            // Before 3000ms, connect should not be called
            jest.advanceTimersByTime(2999);
            expect(client.connect).not.toHaveBeenCalled();

            // At exactly 3000ms, connect should be called
            jest.advanceTimersByTime(1);
            expect(client.connect).toHaveBeenCalledTimes(1);
          }

          // Cleanup
          client._cancelReconnect();
        }
      ),
      { numRuns: 100 }
    );
  });
});
