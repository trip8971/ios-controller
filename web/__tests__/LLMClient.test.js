const LLMClient = require('../LLMClient');

describe('LLMClient', () => {
  let client;

  beforeEach(() => {
    client = new LLMClient();
  });

  describe('constructor', () => {
    test('initializes conversationHistory as an array', () => {
      expect(Array.isArray(client.conversationHistory)).toBe(true);
    });

    test('initializes config with empty strings', () => {
      expect(client.config).toEqual({ baseURL: '', apiKey: '', model: '' });
    });

    test('calls initSystemPrompt on construction', () => {
      expect(client.conversationHistory.length).toBeGreaterThanOrEqual(1);
      expect(client.conversationHistory[0].role).toBe('system');
    });
  });

  describe('initSystemPrompt()', () => {
    test('adds system message as first entry', () => {
      const msg = client.conversationHistory[0];
      expect(msg.role).toBe('system');
      expect(typeof msg.content).toBe('string');
    });

    test('system prompt contains operation keywords', () => {
      const content = client.conversationHistory[0].content;
      expect(content).toContain('screenshot');
      expect(content).toContain('手机');
    });

    test('system prompt contains tool use rules', () => {
      const content = client.conversationHistory[0].content;
      expect(content).toContain('工具');
      expect(content).toContain('归一化');
    });

    test('TOOLS static property defines all operations', () => {
      const LLMClient = require('../LLMClient');
      const toolNames = LLMClient.TOOLS.map(t => t.function.name);
      expect(toolNames).toContain('tap');
      expect(toolNames).toContain('swipe');
      expect(toolNames).toContain('volume_up');
      expect(toolNames).toContain('volume_down');
      expect(toolNames).toContain('home');
      expect(toolNames).toContain('screenshot');
      expect(toolNames).toContain('input');
    });
  });

  describe('addUserMessage(text)', () => {
    test('appends user message to history', () => {
      client.addUserMessage('打开设置');
      const last = client.conversationHistory[client.conversationHistory.length - 1];
      expect(last).toEqual({ role: 'user', content: '打开设置' });
    });

    test('preserves system prompt at index 0', () => {
      client.addUserMessage('hello');
      expect(client.conversationHistory[0].role).toBe('system');
    });
  });

  describe('addAssistantMessage(text)', () => {
    test('appends assistant message to history', () => {
      client.addAssistantMessage('Thought: 我需要点击设置图标');
      const last = client.conversationHistory[client.conversationHistory.length - 1];
      expect(last).toEqual({ role: 'assistant', content: 'Thought: 我需要点击设置图标' });
    });
  });

  describe('addObservation(content)', () => {
    test('appends observation as user role message', () => {
      client.addObservation('操作已执行');
      const last = client.conversationHistory[client.conversationHistory.length - 1];
      expect(last).toEqual({ role: 'user', content: '操作已执行' });
    });
  });

  describe('addImageObservation(base64Image)', () => {
    test('appends multimodal message in OpenAI Vision API format', () => {
      const base64 = 'iVBORw0KGgoAAAANSUhEUg==';
      client.addImageObservation(base64);
      const last = client.conversationHistory[client.conversationHistory.length - 1];

      expect(last.role).toBe('user');
      expect(Array.isArray(last.content)).toBe(true);
      expect(last.content).toHaveLength(2);
    });

    test('first content block is text type with observation label', () => {
      client.addImageObservation('abc123');
      const last = client.conversationHistory[client.conversationHistory.length - 1];
      expect(last.content[0]).toEqual({
        type: 'text',
        text: 'Observation: 以下是当前屏幕截图'
      });
    });

    test('second content block is image_url type with data URI', () => {
      const base64 = 'testImageData';
      client.addImageObservation(base64);
      const last = client.conversationHistory[client.conversationHistory.length - 1];
      expect(last.content[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,testImageData' }
      });
    });
  });

  describe('clearHistory()', () => {
    test('clears all messages and re-initializes system prompt', () => {
      client.addUserMessage('hello');
      client.addAssistantMessage('hi');
      client.addObservation('done');

      client.clearHistory();

      expect(client.conversationHistory).toHaveLength(1);
      expect(client.conversationHistory[0].role).toBe('system');
    });

    test('system prompt after clear is identical to initial', () => {
      const initialPrompt = client.conversationHistory[0].content;
      client.addUserMessage('test');
      client.clearHistory();
      expect(client.conversationHistory[0].content).toBe(initialPrompt);
    });
  });

  describe('updateConfig(config)', () => {
    test('merges provided config into existing config', () => {
      client.updateConfig({ baseURL: 'https://api.example.com/v1' });
      expect(client.config.baseURL).toBe('https://api.example.com/v1');
      expect(client.config.apiKey).toBe('');
      expect(client.config.model).toBe('');
    });

    test('updates multiple fields at once', () => {
      client.updateConfig({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o'
      });
      expect(client.config).toEqual({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o'
      });
    });

    test('partial update preserves existing values', () => {
      client.updateConfig({ apiKey: 'sk-first' });
      client.updateConfig({ model: 'gpt-4' });
      expect(client.config.apiKey).toBe('sk-first');
      expect(client.config.model).toBe('gpt-4');
    });
  });

  describe('conversation history ordering', () => {
    test('messages are appended in order', () => {
      client.addUserMessage('msg1');
      client.addAssistantMessage('msg2');
      client.addObservation('msg3');
      client.addImageObservation('img');

      expect(client.conversationHistory[0].role).toBe('system');
      expect(client.conversationHistory[1]).toEqual({ role: 'user', content: 'msg1' });
      expect(client.conversationHistory[2]).toEqual({ role: 'assistant', content: 'msg2' });
      expect(client.conversationHistory[3]).toEqual({ role: 'user', content: 'msg3' });
      expect(client.conversationHistory[4].role).toBe('user');
      expect(Array.isArray(client.conversationHistory[4].content)).toBe(true);
    });
  });
});
