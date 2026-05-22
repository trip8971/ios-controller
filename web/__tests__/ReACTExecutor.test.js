const ReACTExecutor = require('../ReACTExecutor');

describe('ReACTExecutor', () => {
  let executor;

  beforeEach(() => {
    executor = new ReACTExecutor({}, {}, {});
  });

  describe('constructor', () => {
    it('should store dependencies', () => {
      const llm = { id: 'llm' };
      const chat = { id: 'chat' };
      const remote = { id: 'remote' };
      const ex = new ReACTExecutor(llm, chat, remote);
      expect(ex.llmClient).toBe(llm);
      expect(ex.chatPanel).toBe(chat);
      expect(ex.remoteClient).toBe(remote);
    });

    it('should set maxIterations to Infinity', () => {
      expect(executor.maxIterations).toBe(Infinity);
    });

    it('should set isRunning to false', () => {
      expect(executor.isRunning).toBe(false);
    });
  });

  describe('clampCoordinate', () => {
    it('returns same value within [0, 1]', () => {
      expect(executor.clampCoordinate(0)).toBe(0);
      expect(executor.clampCoordinate(0.5)).toBe(0.5);
      expect(executor.clampCoordinate(1)).toBe(1);
    });

    it('clamps below 0 to 0', () => {
      expect(executor.clampCoordinate(-0.5)).toBe(0);
    });

    it('clamps above 1 to 1', () => {
      expect(executor.clampCoordinate(1.5)).toBe(1);
    });
  });

  describe('convertToCommand', () => {
    it('converts tap action', () => {
      expect(executor.convertToCommand({ action: 'tap', x: 0.5, y: 0.3 }))
        .toEqual({ type: 'tap', x: 0.5, y: 0.3, normalized: true });
    });

    it('clamps tap coordinates', () => {
      expect(executor.convertToCommand({ action: 'tap', x: -0.2, y: 1.5 }))
        .toEqual({ type: 'tap', x: 0, y: 1, normalized: true });
    });

    it('converts swipe action', () => {
      expect(executor.convertToCommand({ action: 'swipe', x: 0.5, y: 0.5, dx: 0.3, dy: -0.2, duration: 0.3 }))
        .toEqual({ type: 'swipe', startX: 0.5, startY: 0.5, endX: 0.8, endY: 0.3, normalized: true, duration: 0.3 });
    });

    it('converts volume_up', () => {
      expect(executor.convertToCommand({ action: 'volume_up' })).toEqual({ type: 'volume_up' });
    });

    it('converts volume_down', () => {
      expect(executor.convertToCommand({ action: 'volume_down' })).toEqual({ type: 'volume_down' });
    });

    it('converts home', () => {
      expect(executor.convertToCommand({ action: 'home' })).toEqual({ type: 'home' });
    });

    it('converts screenshot', () => {
      expect(executor.convertToCommand({ action: 'screenshot' })).toEqual({ type: 'screenshot' });
    });

    it('converts input', () => {
      expect(executor.convertToCommand({ action: 'input', text: 'hello', clearText: true }))
        .toEqual({ type: 'input', text: 'hello', clearText: true });
    });

    it('returns null for unknown action', () => {
      expect(executor.convertToCommand({ action: 'fly' })).toBeNull();
    });
  });

  describe('executeAction', () => {
    let mockRemoteClient;
    let ex;

    beforeEach(() => {
      mockRemoteClient = { sendCommand: jest.fn() };
      ex = new ReACTExecutor({}, {}, mockRemoteClient);
    });

    it('calls takeScreenshot for screenshot', async () => {
      ex.takeScreenshot = jest.fn().mockResolvedValue({ type: 'image', image: 'b64' });
      const result = await ex.executeAction('screenshot', {});
      expect(ex.takeScreenshot).toHaveBeenCalled();
      expect(result).toEqual({ type: 'image', image: 'b64' });
    });

    it('sends tap command via remoteClient', async () => {
      const result = await ex.executeAction('tap', { x: 0.5, y: 0.3 });
      expect(mockRemoteClient.sendCommand).toHaveBeenCalledWith({
        type: 'tap', x: 0.5, y: 0.3, normalized: true
      });
      expect(result).toBe('操作 tap 已执行');
    });

    it('sends home command', async () => {
      const result = await ex.executeAction('home', {});
      expect(mockRemoteClient.sendCommand).toHaveBeenCalledWith({ type: 'home' });
      expect(result).toBe('操作 home 已执行');
    });

    it('returns error for unknown action', async () => {
      const result = await ex.executeAction('fly', {});
      expect(result).toBe('未知操作类型：fly');
    });

    it('catches sendCommand errors', async () => {
      mockRemoteClient.sendCommand.mockImplementation(() => { throw new Error('ws closed'); });
      const result = await ex.executeAction('tap', { x: 0.5, y: 0.5 });
      expect(result).toBe('操作执行失败：ws closed');
    });
  });

  describe('takeScreenshot', () => {
    let ex;

    beforeEach(() => {
      ex = new ReACTExecutor({ apiBase: '' }, {}, {});
      global.fetch = jest.fn();
    });

    afterEach(() => { delete global.fetch; });

    it('returns image on success', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, image: 'abc', format: 'jpeg' })
      });
      const result = await ex.takeScreenshot();
      expect(result).toEqual({ type: 'image', image: 'abc', format: 'jpeg' });
    });

    it('returns error on failure', async () => {
      global.fetch.mockResolvedValue({
        ok: false, status: 502, statusText: 'Bad Gateway',
        json: () => Promise.resolve({ error: 'Agent down' })
      });
      const result = await ex.takeScreenshot();
      expect(result).toBe('截图失败：Agent down');
    });

    it('returns error on network failure', async () => {
      global.fetch.mockRejectedValue(new Error('Network error'));
      const result = await ex.takeScreenshot();
      expect(result).toBe('截图失败：Network error');
    });
  });
});
