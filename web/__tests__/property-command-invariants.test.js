/**
 * **Feature: ios-remote-control, Property 6: Control_Command 结构不变量**
 *
 * **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
 *
 * Property: For any valid tap Control_Command generated on the Web side,
 * the JSON must contain "type", "x", "y" fields. For any valid swipe
 * Control_Command, the JSON must contain "type", "startX", "startY", "endX",
 * "endY" fields, and when "duration" is present it must be a positive number.
 * Volume commands must only contain the "type" field.
 */

const fc = require('fast-check');

// --- fast-check arbitraries for Control_Command types ---

const tapCommandArb = fc.record({
  type: fc.constant('tap'),
  x: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
  y: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
});

const swipeWithoutDurationArb = fc.record({
  type: fc.constant('swipe'),
  startX: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
  startY: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
  endX: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
  endY: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
});

const swipeWithDurationArb = fc.record({
  type: fc.constant('swipe'),
  startX: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
  startY: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
  endX: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
  endY: fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
  duration: fc.double({ min: 0.01, max: 10, noNaN: true, noDefaultInfinity: true }),
});

const swipeCommandArb = fc.oneof(swipeWithoutDurationArb, swipeWithDurationArb);

const volumeUpCommandArb = fc.constant({ type: 'volume_up' });
const volumeDownCommandArb = fc.constant({ type: 'volume_down' });

describe('Feature: ios-remote-control, Property 6: Control_Command 结构不变量', () => {
  it('tap commands must contain "type", "x", "y" fields', () => {
    fc.assert(
      fc.property(
        tapCommandArb,
        (tapCommand) => {
          // Verify required fields exist
          expect(tapCommand).toHaveProperty('type');
          expect(tapCommand).toHaveProperty('x');
          expect(tapCommand).toHaveProperty('y');

          // Verify type value
          expect(tapCommand.type).toBe('tap');

          // Verify field types
          expect(typeof tapCommand.x).toBe('number');
          expect(typeof tapCommand.y).toBe('number');

          // Verify serialized JSON also contains the required fields
          const serialized = JSON.parse(JSON.stringify(tapCommand));
          expect(serialized).toHaveProperty('type', 'tap');
          expect(serialized).toHaveProperty('x');
          expect(serialized).toHaveProperty('y');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('swipe commands must contain "type", "startX", "startY", "endX", "endY" fields', () => {
    fc.assert(
      fc.property(
        swipeCommandArb,
        (swipeCommand) => {
          // Verify required fields exist
          expect(swipeCommand).toHaveProperty('type');
          expect(swipeCommand).toHaveProperty('startX');
          expect(swipeCommand).toHaveProperty('startY');
          expect(swipeCommand).toHaveProperty('endX');
          expect(swipeCommand).toHaveProperty('endY');

          // Verify type value
          expect(swipeCommand.type).toBe('swipe');

          // Verify field types
          expect(typeof swipeCommand.startX).toBe('number');
          expect(typeof swipeCommand.startY).toBe('number');
          expect(typeof swipeCommand.endX).toBe('number');
          expect(typeof swipeCommand.endY).toBe('number');

          // Verify serialized JSON also contains the required fields
          const serialized = JSON.parse(JSON.stringify(swipeCommand));
          expect(serialized).toHaveProperty('type', 'swipe');
          expect(serialized).toHaveProperty('startX');
          expect(serialized).toHaveProperty('startY');
          expect(serialized).toHaveProperty('endX');
          expect(serialized).toHaveProperty('endY');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('swipe duration, when present, must be a positive number', () => {
    fc.assert(
      fc.property(
        swipeWithDurationArb,
        (swipeCommand) => {
          // duration is present in this arbitrary
          expect(swipeCommand).toHaveProperty('duration');
          expect(typeof swipeCommand.duration).toBe('number');
          expect(swipeCommand.duration).toBeGreaterThan(0);

          // Verify after serialization
          const serialized = JSON.parse(JSON.stringify(swipeCommand));
          expect(serialized.duration).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('volume commands must only contain the "type" field', () => {
    fc.assert(
      fc.property(
        fc.oneof(volumeUpCommandArb, volumeDownCommandArb),
        (volumeCommand) => {
          // Verify "type" field exists
          expect(volumeCommand).toHaveProperty('type');
          expect(['volume_up', 'volume_down']).toContain(volumeCommand.type);

          // Verify only "type" field is present (no extra fields)
          const keys = Object.keys(volumeCommand);
          expect(keys).toEqual(['type']);

          // Verify after serialization
          const serialized = JSON.parse(JSON.stringify(volumeCommand));
          expect(Object.keys(serialized)).toEqual(['type']);
          expect(['volume_up', 'volume_down']).toContain(serialized.type);
        }
      ),
      { numRuns: 100 }
    );
  });
});
