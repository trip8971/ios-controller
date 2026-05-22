/**
 * **Feature: ios-remote-control, Property 3: 坐标映射比例正确性**
 *
 * 属性 3：坐标映射比例正确性
 * 对于任意有效的 Web 端坐标 (clientX, clientY) 和任意正数的显示尺寸
 * (displayWidth, displayHeight) 与设备分辨率 (deviceWidth, deviceHeight)，
 * Coordinate_Mapping 转换后的设备坐标应满足：
 *   deviceX / deviceWidth == clientX / displayWidth
 *   deviceY / deviceHeight == clientY / displayHeight
 * （在浮点精度范围内）
 *
 * **Validates: Requirements 4.1, 4.2, 4.7**
 */

const fc = require('fast-check');
const { CoordinateMapper } = require('../app');

describe('Feature: ios-remote-control, Property 3: 坐标映射比例正确性', () => {
  it('should preserve coordinate ratios after mapping (deviceX/deviceWidth ≈ clientX/displayWidth)', () => {
    fc.assert(
      fc.property(
        // Generate positive display dimensions (avoid zero to prevent division by zero)
        fc.float({ min: 1, max: 10000, noNaN: true }),   // displayWidth
        fc.float({ min: 1, max: 10000, noNaN: true }),   // displayHeight
        // Generate positive device dimensions
        fc.float({ min: 1, max: 10000, noNaN: true }),   // deviceWidth
        fc.float({ min: 1, max: 10000, noNaN: true }),   // deviceHeight
        // Generate valid coordinates within display bounds
        fc.float({ min: 0, max: 10000, noNaN: true }),   // clientX
        fc.float({ min: 0, max: 10000, noNaN: true }),   // clientY
        (displayWidth, displayHeight, deviceWidth, deviceHeight, rawClientX, rawClientY) => {
          // Ensure dimensions are positive (filter out zero/negative from float generation)
          if (displayWidth <= 0 || displayHeight <= 0 || deviceWidth <= 0 || deviceHeight <= 0) return;

          // Clamp coordinates to be within display bounds
          const clientX = Math.min(rawClientX, displayWidth);
          const clientY = Math.min(rawClientY, displayHeight);

          // Skip if coordinates are negative
          if (clientX < 0 || clientY < 0) return;

          const mapper = new CoordinateMapper(displayWidth, displayHeight, deviceWidth, deviceHeight);
          const { x: deviceX, y: deviceY } = mapper.mapToDevice(clientX, clientY);

          // Verify ratio preservation: deviceX / deviceWidth ≈ clientX / displayWidth
          const expectedRatioX = clientX / displayWidth;
          const actualRatioX = deviceX / deviceWidth;

          const expectedRatioY = clientY / displayHeight;
          const actualRatioY = deviceY / deviceHeight;

          // Use relative tolerance for floating point comparison
          const tolerance = 1e-6;

          expect(Math.abs(actualRatioX - expectedRatioX)).toBeLessThanOrEqual(
            tolerance + tolerance * Math.abs(expectedRatioX)
          );
          expect(Math.abs(actualRatioY - expectedRatioY)).toBeLessThanOrEqual(
            tolerance + tolerance * Math.abs(expectedRatioY)
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});
