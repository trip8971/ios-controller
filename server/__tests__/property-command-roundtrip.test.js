/**
 * **Feature: ios-remote-control, Property 5: Control_Command 往返一致性**
 *
 * **Validates: Requirements 7.3, 8.5**
 *
 * Property: For any valid Control_Command object (including tap, swipe,
 * volume_up, volume_down), serializing it to a JSON string and then
 * deserializing it back should produce a semantically equivalent
 * Control_Command object.
 */

const fc = require('fast-check');

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
  // swipe with optional duration (positive when present)
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

describe('Feature: ios-remote-control, Property 5: Control_Command 往返一致性', () => {
  it('any valid Control_Command should survive JSON roundtrip with semantic equivalence', () => {
    fc.assert(
      fc.property(
        controlCommandArb,
        (command) => {
          // Serialize to JSON string
          const jsonString = JSON.stringify(command);

          // Deserialize back to object
          const deserialized = JSON.parse(jsonString);

          // Verify deep equality (semantic equivalence)
          expect(deserialized).toEqual(command);

          // Verify the type field is preserved
          expect(deserialized.type).toBe(command.type);

          // Verify the deserialized object has the same keys
          expect(Object.keys(deserialized).sort()).toEqual(Object.keys(command).sort());
        }
      ),
      { numRuns: 100 }
    );
  });

  it('tap commands should preserve x and y coordinates through JSON roundtrip', () => {
    fc.assert(
      fc.property(
        tapCommandArb,
        (tapCommand) => {
          const deserialized = JSON.parse(JSON.stringify(tapCommand));

          expect(deserialized.type).toBe('tap');
          expect(deserialized.x).toBe(tapCommand.x);
          expect(deserialized.y).toBe(tapCommand.y);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('swipe commands should preserve all fields including optional duration through JSON roundtrip', () => {
    fc.assert(
      fc.property(
        swipeCommandArb,
        (swipeCommand) => {
          const deserialized = JSON.parse(JSON.stringify(swipeCommand));

          expect(deserialized.type).toBe('swipe');
          expect(deserialized.startX).toBe(swipeCommand.startX);
          expect(deserialized.startY).toBe(swipeCommand.startY);
          expect(deserialized.endX).toBe(swipeCommand.endX);
          expect(deserialized.endY).toBe(swipeCommand.endY);

          // duration is optional — verify it's preserved when present
          if ('duration' in swipeCommand) {
            expect(deserialized.duration).toBe(swipeCommand.duration);
          } else {
            expect(deserialized).not.toHaveProperty('duration');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('volume commands should preserve type field through JSON roundtrip', () => {
    fc.assert(
      fc.property(
        fc.oneof(volumeUpCommandArb, volumeDownCommandArb),
        (volumeCommand) => {
          const deserialized = JSON.parse(JSON.stringify(volumeCommand));

          expect(deserialized).toEqual(volumeCommand);
          expect(typeof deserialized.type).toBe('string');
          expect(['volume_up', 'volume_down']).toContain(deserialized.type);
        }
      ),
      { numRuns: 100 }
    );
  });
});
