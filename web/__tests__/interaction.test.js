/**
 * Unit tests for CoordinateMapper and InteractionHandler
 * Task 3.4: 交互捕获与控制指令发送
 */

const { CoordinateMapper, InteractionHandler } = require('../app');

// ============================================================
// CoordinateMapper Tests
// ============================================================
describe('CoordinateMapper', () => {
  test('maps coordinates using correct ratio formula', () => {
    // Display: 320x694, Device: 393x852
    const mapper = new CoordinateMapper(320, 694, 393, 852);

    const result = mapper.mapToDevice(160, 347);
    // deviceX = 160 * (393/320) = 196.5
    // deviceY = 347 * (852/694) = 425.99...
    expect(result.x).toBeCloseTo(196.5, 5);
    expect(result.y).toBeCloseTo(347 * (852 / 694), 5);
  });

  test('maps origin (0, 0) to device origin (0, 0)', () => {
    const mapper = new CoordinateMapper(320, 694, 393, 852);
    const result = mapper.mapToDevice(0, 0);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  test('maps max display coordinates to max device coordinates', () => {
    const mapper = new CoordinateMapper(320, 694, 393, 852);
    const result = mapper.mapToDevice(320, 694);
    expect(result.x).toBeCloseTo(393, 5);
    expect(result.y).toBeCloseTo(852, 5);
  });

  test('preserves proportional relationship', () => {
    const mapper = new CoordinateMapper(200, 400, 393, 852);
    const clientX = 100;
    const clientY = 200;
    const result = mapper.mapToDevice(clientX, clientY);

    // deviceX / deviceWidth should equal clientX / displayWidth
    expect(result.x / 393).toBeCloseTo(clientX / 200, 10);
    expect(result.y / 852).toBeCloseTo(clientY / 400, 10);
  });

  test('works with 1:1 ratio (display equals device)', () => {
    const mapper = new CoordinateMapper(393, 852, 393, 852);
    const result = mapper.mapToDevice(100, 200);
    expect(result.x).toBeCloseTo(100, 10);
    expect(result.y).toBeCloseTo(200, 10);
  });
});

// ============================================================
// InteractionHandler Tests
// ============================================================
describe('InteractionHandler', () => {
  let screenElement;
  let mockClient;
  let handler;

  beforeEach(() => {
    // Create a mock screen element with getBoundingClientRect
    screenElement = document.createElement('div');
    Object.defineProperty(screenElement, 'getBoundingClientRect', {
      value: () => ({
        left: 50,
        top: 100,
        width: 320,
        height: 694,
        right: 370,
        bottom: 794
      })
    });
    document.body.appendChild(screenElement);

    // Mock client with sendCommand spy
    mockClient = {
      sendCommand: jest.fn()
    };

    handler = new InteractionHandler(screenElement, mockClient, { width: 393, height: 852 });
  });

  afterEach(() => {
    handler.destroy();
    document.body.removeChild(screenElement);
  });

  test('generates tap command for click without movement', () => {
    // Simulate mousedown
    const mousedown = new MouseEvent('mousedown', {
      button: 0,
      clientX: 210,  // relative to screen: 210 - 50 = 160
      clientY: 447,  // relative to screen: 447 - 100 = 347
      bubbles: true
    });
    screenElement.dispatchEvent(mousedown);

    // Simulate mouseup at same position
    const mouseup = new MouseEvent('mouseup', {
      button: 0,
      clientX: 210,
      clientY: 447,
      bubbles: true
    });
    screenElement.dispatchEvent(mouseup);

    expect(mockClient.sendCommand).toHaveBeenCalledTimes(1);
    const cmd = mockClient.sendCommand.mock.calls[0][0];
    expect(cmd.type).toBe('tap');
    // Code now sends normalized coordinates (0-1)
    expect(cmd.normalized).toBe(true);
    expect(cmd.x).toBeCloseTo(160 / 320, 2);  // 0.5
    expect(cmd.y).toBeCloseTo(347 / 694, 2);   // ~0.5
  });

  test('generates swipe command when mouse moves beyond threshold', () => {
    // Simulate mousedown
    const mousedown = new MouseEvent('mousedown', {
      button: 0,
      clientX: 210,  // relative: 160
      clientY: 447,  // relative: 347
      bubbles: true
    });
    screenElement.dispatchEvent(mousedown);

    // Simulate mousemove (significant movement)
    const mousemove = new MouseEvent('mousemove', {
      button: 0,
      clientX: 210,
      clientY: 347,  // relative: 247, moved 100px
      bubbles: true
    });
    screenElement.dispatchEvent(mousemove);

    // Simulate mouseup at new position
    const mouseup = new MouseEvent('mouseup', {
      button: 0,
      clientX: 210,
      clientY: 347,  // relative: 247
      bubbles: true
    });
    screenElement.dispatchEvent(mouseup);

    expect(mockClient.sendCommand).toHaveBeenCalledTimes(1);
    const cmd = mockClient.sendCommand.mock.calls[0][0];
    expect(cmd.type).toBe('swipe');
    expect(cmd.normalized).toBe(true);
    expect(cmd.startX).toBeCloseTo(160 / 320, 2);
    expect(cmd.startY).toBeCloseTo(347 / 694, 2);
    expect(cmd.endX).toBeCloseTo(160 / 320, 2);
    expect(cmd.endY).toBeCloseTo(247 / 694, 2);
    expect(cmd.duration).toBeGreaterThanOrEqual(0.1); // min duration
  });

  test('swipe duration defaults to 0.5s when gesture is too fast', () => {
    const mousedown = new MouseEvent('mousedown', {
      button: 0,
      clientX: 210,
      clientY: 447,
      bubbles: true
    });
    screenElement.dispatchEvent(mousedown);

    // Immediate mouseup at different position (very fast swipe)
    const mouseup = new MouseEvent('mouseup', {
      button: 0,
      clientX: 210,
      clientY: 200, // big movement
      bubbles: true
    });
    screenElement.dispatchEvent(mouseup);

    const cmd = mockClient.sendCommand.mock.calls[0][0];
    expect(cmd.type).toBe('swipe');
    expect(cmd.duration).toBeGreaterThanOrEqual(0.1); // min swipe duration
  });

  test('ignores right-click (button !== 0)', () => {
    const mousedown = new MouseEvent('mousedown', {
      button: 2, // right click
      clientX: 210,
      clientY: 447,
      bubbles: true
    });
    screenElement.dispatchEvent(mousedown);

    const mouseup = new MouseEvent('mouseup', {
      button: 2,
      clientX: 210,
      clientY: 447,
      bubbles: true
    });
    screenElement.dispatchEvent(mouseup);

    expect(mockClient.sendCommand).not.toHaveBeenCalled();
  });

  test('does not send command if mouseup without prior mousedown', () => {
    const mouseup = new MouseEvent('mouseup', {
      button: 0,
      clientX: 210,
      clientY: 447,
      bubbles: true
    });
    screenElement.dispatchEvent(mouseup);

    expect(mockClient.sendCommand).not.toHaveBeenCalled();
  });

  test('tap command has correct JSON structure', () => {
    const mousedown = new MouseEvent('mousedown', {
      button: 0,
      clientX: 100,
      clientY: 200,
      bubbles: true
    });
    screenElement.dispatchEvent(mousedown);

    const mouseup = new MouseEvent('mouseup', {
      button: 0,
      clientX: 100,
      clientY: 200,
      bubbles: true
    });
    screenElement.dispatchEvent(mouseup);

    const cmd = mockClient.sendCommand.mock.calls[0][0];
    expect(cmd).toHaveProperty('type', 'tap');
    expect(cmd).toHaveProperty('x');
    expect(cmd).toHaveProperty('y');
    expect(typeof cmd.x).toBe('number');
    expect(typeof cmd.y).toBe('number');
  });

  test('swipe command has correct JSON structure', () => {
    const mousedown = new MouseEvent('mousedown', {
      button: 0,
      clientX: 100,
      clientY: 200,
      bubbles: true
    });
    screenElement.dispatchEvent(mousedown);

    const mouseup = new MouseEvent('mouseup', {
      button: 0,
      clientX: 100,
      clientY: 400, // big vertical movement
      bubbles: true
    });
    screenElement.dispatchEvent(mouseup);

    const cmd = mockClient.sendCommand.mock.calls[0][0];
    expect(cmd).toHaveProperty('type', 'swipe');
    expect(cmd).toHaveProperty('startX');
    expect(cmd).toHaveProperty('startY');
    expect(cmd).toHaveProperty('endX');
    expect(cmd).toHaveProperty('endY');
    expect(cmd).toHaveProperty('duration');
    expect(typeof cmd.startX).toBe('number');
    expect(typeof cmd.startY).toBe('number');
    expect(typeof cmd.endX).toBe('number');
    expect(typeof cmd.endY).toBe('number');
    expect(typeof cmd.duration).toBe('number');
    expect(cmd.duration).toBeGreaterThan(0);
  });

  test('movement within threshold (<=5px) is treated as tap', () => {
    const mousedown = new MouseEvent('mousedown', {
      button: 0,
      clientX: 210,
      clientY: 447,
      bubbles: true
    });
    screenElement.dispatchEvent(mousedown);

    // Move only 3px (within 5px threshold)
    const mouseup = new MouseEvent('mouseup', {
      button: 0,
      clientX: 213,
      clientY: 447,
      bubbles: true
    });
    screenElement.dispatchEvent(mouseup);

    const cmd = mockClient.sendCommand.mock.calls[0][0];
    expect(cmd.type).toBe('tap');
  });

  test('destroy removes event listeners', () => {
    handler.destroy();

    const mousedown = new MouseEvent('mousedown', {
      button: 0,
      clientX: 210,
      clientY: 447,
      bubbles: true
    });
    screenElement.dispatchEvent(mousedown);

    const mouseup = new MouseEvent('mouseup', {
      button: 0,
      clientX: 210,
      clientY: 447,
      bubbles: true
    });
    screenElement.dispatchEvent(mouseup);

    expect(mockClient.sendCommand).not.toHaveBeenCalled();
  });
});
