const LLMClient = require('../LLMClient');

describe('LLMClient.parseReACTResponse()', () => {
  let client;

  beforeEach(() => {
    client = new LLMClient();
  });

  describe('Thought + Action parsing', () => {
    test('parses Thought and Action from response', () => {
      const input = 'Thought: 我需要点击设置\nAction: {"action": "tap", "x": 0.5, "y": 0.3}';
      const result = client.parseReACTResponse(input);

      expect(result.thought).toBe('我需要点击设置');
      expect(result.action).toEqual({ action: 'tap', x: 0.5, y: 0.3 });
      expect(result.finalAnswer).toBeUndefined();
      expect(result.raw).toBe(input);
    });

    test('parses Thought + screenshot Action', () => {
      const input = 'Thought: 分析屏幕\nAction: {"action": "screenshot"}';
      const result = client.parseReACTResponse(input);

      expect(result.thought).toBe('分析屏幕');
      expect(result.action).toEqual({ action: 'screenshot' });
      expect(result.finalAnswer).toBeUndefined();
    });
  });

  describe('Final Answer only', () => {
    test('parses Final Answer from response', () => {
      const input = 'Final Answer: 已完成设置操作';
      const result = client.parseReACTResponse(input);

      expect(result.thought).toBeUndefined();
      expect(result.action).toBeUndefined();
      expect(result.finalAnswer).toBe('已完成设置操作');
      expect(result.raw).toBe(input);
    });
  });

  describe('plain text fallback', () => {
    test('treats plain text as finalAnswer when no markers found', () => {
      const input = '这是一段普通文本';
      const result = client.parseReACTResponse(input);

      expect(result.thought).toBeUndefined();
      expect(result.action).toBeUndefined();
      expect(result.finalAnswer).toBe('这是一段普通文本');
      expect(result.raw).toBe(input);
    });
  });

  describe('all three sections', () => {
    test('parses Thought, Action, and Final Answer together', () => {
      const input = 'Thought: 需要分析\nAction: {"action": "tap", "x": 0.1, "y": 0.2}\nFinal Answer: 操作完成';
      const result = client.parseReACTResponse(input);

      expect(result.thought).toBe('需要分析');
      expect(result.action).toEqual({ action: 'tap', x: 0.1, y: 0.2 });
      expect(result.finalAnswer).toBe('操作完成');
    });
  });

  describe('invalid Action JSON', () => {
    test('leaves action undefined when JSON is invalid', () => {
      const input = 'Thought: 分析中\nAction: {invalid json here}';
      const result = client.parseReACTResponse(input);

      expect(result.thought).toBe('分析中');
      expect(result.action).toBeUndefined();
      expect(result.finalAnswer).toBeUndefined();
    });
  });

  describe('multiline thought', () => {
    test('captures multiline thought text', () => {
      const input = 'Thought: 第一行分析\n第二行分析\n第三行分析\nAction: {"action": "home"}';
      const result = client.parseReACTResponse(input);

      expect(result.thought).toBe('第一行分析\n第二行分析\n第三行分析');
      expect(result.action).toEqual({ action: 'home' });
    });
  });

  describe('empty input', () => {
    test('returns undefined finalAnswer for empty string', () => {
      const result = client.parseReACTResponse('');

      expect(result.thought).toBeUndefined();
      expect(result.action).toBeUndefined();
      expect(result.finalAnswer).toBeUndefined();
      expect(result.raw).toBe('');
    });
  });

  describe('raw field', () => {
    test('always contains the original input text', () => {
      const input = 'Thought: test\nAction: {"action": "home"}';
      const result = client.parseReACTResponse(input);
      expect(result.raw).toBe(input);
    });
  });
});
