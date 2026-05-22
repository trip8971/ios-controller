/**
 * @jest-environment jsdom
 */

const ChatPanel = require('../ChatPanel');

describe('ChatPanel', () => {
  let container;
  let panel;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    panel = new ChatPanel(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  describe('DOM structure creation', () => {
    test('creates message list inside container', () => {
      const messageList = container.querySelector('.chat-message-list');
      expect(messageList).not.toBeNull();
    });

    test('creates input area with input field, submit button, and loading indicator', () => {
      const inputArea = container.querySelector('.chat-input-area');
      expect(inputArea).not.toBeNull();

      const input = container.querySelector('.chat-input');
      expect(input).not.toBeNull();
      expect(input.type).toBe('text');
      expect(input.placeholder).toBe('输入指令...');

      const btn = container.querySelector('.chat-submit-btn');
      expect(btn).not.toBeNull();
      expect(btn.textContent).toBe('发送');

      const loading = container.querySelector('.chat-loading');
      expect(loading).not.toBeNull();
      expect(loading.classList.contains('hidden')).toBe(true);
    });
  });

  describe('appendUserMessage()', () => {
    test('adds a user message to the message list', () => {
      panel.appendUserMessage('Hello');
      const msgs = container.querySelectorAll('.user-message');
      expect(msgs.length).toBe(1);
      expect(msgs[0].textContent).toBe('Hello');
    });

    test('appends multiple user messages in order', () => {
      panel.appendUserMessage('First');
      panel.appendUserMessage('Second');
      const msgs = container.querySelectorAll('.user-message');
      expect(msgs.length).toBe(2);
      expect(msgs[0].textContent).toBe('First');
      expect(msgs[1].textContent).toBe('Second');
    });
  });

  describe('createAssistantMessage()', () => {
    test('returns a unique messageId', () => {
      const id1 = panel.createAssistantMessage();
      const id2 = panel.createAssistantMessage();
      expect(typeof id1).toBe('string');
      expect(typeof id2).toBe('string');
      expect(id1).not.toBe(id2);
    });

    test('creates an assistant message element with text span and streaming cursor', () => {
      panel.createAssistantMessage();
      const msg = container.querySelector('.assistant-message');
      expect(msg).not.toBeNull();
      expect(msg.querySelector('.message-text')).not.toBeNull();
      expect(msg.querySelector('.streaming-cursor')).not.toBeNull();
    });
  });

  describe('appendStreamingText()', () => {
    test('appends chunk text to the specified assistant message', () => {
      const id = panel.createAssistantMessage();
      panel.appendStreamingText(id, 'Hello');
      panel.appendStreamingText(id, ' World');
      const textSpan = container.querySelector('.assistant-message .message-text');
      expect(textSpan.textContent).toBe('Hello World');
    });

    test('does nothing for unknown messageId', () => {
      expect(() => panel.appendStreamingText('unknown-id', 'text')).not.toThrow();
    });
  });

  describe('finalizeAssistantMessage()', () => {
    test('sets full text and removes streaming cursor', () => {
      const id = panel.createAssistantMessage();
      panel.appendStreamingText(id, 'partial');
      panel.finalizeAssistantMessage(id, 'complete text');

      const textSpan = container.querySelector('.assistant-message .message-text');
      expect(textSpan.textContent).toBe('complete text');

      const cursor = container.querySelector('.assistant-message .streaming-cursor');
      expect(cursor).toBeNull();
    });

    test('does nothing for unknown messageId', () => {
      expect(() => panel.finalizeAssistantMessage('unknown-id', 'text')).not.toThrow();
    });
  });

  describe('appendActionMessage()', () => {
    test('displays action and observation', () => {
      const action = { action: 'tap', x: 0.5, y: 0.5 };
      panel.appendActionMessage(action, '操作已执行');

      const msg = container.querySelector('.action-message');
      expect(msg).not.toBeNull();

      const actionText = msg.querySelector('.action-text');
      expect(actionText.textContent).toContain('tap');

      const obsText = msg.querySelector('.observation-text');
      expect(obsText.textContent).toBe('操作已执行');
    });

    test('displays image observation as placeholder text', () => {
      panel.appendActionMessage({ action: 'screenshot' }, { type: 'image' });
      const obsText = container.querySelector('.observation-text');
      expect(obsText.textContent).toBe('Observation: [截图已获取]');
    });

    test('handles null action gracefully', () => {
      panel.appendActionMessage(null, 'some observation');
      const msg = container.querySelector('.action-message');
      expect(msg).not.toBeNull();
      expect(msg.querySelector('.action-text')).toBeNull();
      expect(msg.querySelector('.observation-text').textContent).toBe('some observation');
    });
  });

  describe('setLoading()', () => {
    test('disables input and button when loading is true', () => {
      panel.setLoading(true);
      expect(panel.inputField.disabled).toBe(true);
      expect(panel.submitBtn.disabled).toBe(true);
      expect(panel.loadingIndicator.classList.contains('hidden')).toBe(false);
    });

    test('enables input and button when loading is false', () => {
      panel.setLoading(true);
      panel.setLoading(false);
      expect(panel.inputField.disabled).toBe(false);
      expect(panel.submitBtn.disabled).toBe(false);
      expect(panel.loadingIndicator.classList.contains('hidden')).toBe(true);
    });
  });

  describe('clearMessages()', () => {
    test('removes all messages from the list', () => {
      panel.appendUserMessage('msg1');
      panel.createAssistantMessage();
      panel.clearMessages();

      const msgs = container.querySelectorAll('.chat-message');
      expect(msgs.length).toBe(0);
    });

    test('clears internal messages map', () => {
      const id = panel.createAssistantMessage();
      panel.clearMessages();
      // appendStreamingText should not throw for cleared message
      expect(() => panel.appendStreamingText(id, 'text')).not.toThrow();
    });
  });

  describe('getAndClearInput()', () => {
    test('returns trimmed input text and clears the field', () => {
      panel.inputField.value = '  hello world  ';
      const result = panel.getAndClearInput();
      expect(result).toBe('hello world');
      expect(panel.inputField.value).toBe('');
    });

    test('returns empty string for whitespace-only input', () => {
      panel.inputField.value = '   \t  ';
      const result = panel.getAndClearInput();
      expect(result).toBe('');
      expect(panel.inputField.value).toBe('');
    });

    test('returns empty string for empty input', () => {
      panel.inputField.value = '';
      const result = panel.getAndClearInput();
      expect(result).toBe('');
    });
  });

  describe('LLM config settings area', () => {
    test('creates settings area in DOM', () => {
      const settingsArea = container.querySelector('.chat-settings');
      expect(settingsArea).not.toBeNull();
    });

    test('creates settings toggle button', () => {
      const toggle = container.querySelector('.chat-settings-toggle');
      expect(toggle).not.toBeNull();
      expect(toggle.textContent).toBe('⚙️ 设置');
    });

    test('settings content is initially hidden', () => {
      const content = container.querySelector('.chat-settings-content');
      expect(content).not.toBeNull();
      expect(content.classList.contains('hidden')).toBe(true);
    });

    test('toggle button shows/hides settings content', () => {
      const toggle = container.querySelector('.chat-settings-toggle');
      const content = container.querySelector('.chat-settings-content');

      toggle.click();
      expect(content.classList.contains('hidden')).toBe(false);

      toggle.click();
      expect(content.classList.contains('hidden')).toBe(true);
    });

    test('creates baseURL, apiKey, and model input fields', () => {
      const inputs = container.querySelectorAll('.chat-settings-input');
      expect(inputs.length).toBe(3);

      expect(inputs[0].type).toBe('text');
      expect(inputs[0].placeholder).toBe('API Base URL');

      expect(inputs[1].type).toBe('password');
      expect(inputs[1].placeholder).toBe('API Key');

      expect(inputs[2].type).toBe('text');
      expect(inputs[2].placeholder).toBe('模型名称 (如 gpt-4o)');
    });

    test('creates save config button', () => {
      const saveBtn = container.querySelector('.chat-settings-save');
      expect(saveBtn).not.toBeNull();
      expect(saveBtn.textContent).toBe('保存配置');
    });

    test('settings area appears before message list in DOM', () => {
      const children = Array.from(container.children);
      const settingsIndex = children.indexOf(container.querySelector('.chat-settings'));
      const messageListIndex = children.indexOf(container.querySelector('.chat-message-list'));
      expect(settingsIndex).toBeLessThan(messageListIndex);
    });
  });

  describe('getConfig()', () => {
    test('returns current config values', () => {
      panel.baseURLInput.value = 'https://api.example.com';
      panel.apiKeyInput.value = 'sk-test-key';
      panel.modelInput.value = 'gpt-4o';

      const config = panel.getConfig();
      expect(config).toEqual({
        baseURL: 'https://api.example.com',
        apiKey: 'sk-test-key',
        model: 'gpt-4o'
      });
    });

    test('trims whitespace from config values', () => {
      panel.baseURLInput.value = '  https://api.example.com  ';
      panel.apiKeyInput.value = '  sk-test-key  ';
      panel.modelInput.value = '  gpt-4o  ';

      const config = panel.getConfig();
      expect(config).toEqual({
        baseURL: 'https://api.example.com',
        apiKey: 'sk-test-key',
        model: 'gpt-4o'
      });
    });

    test('returns empty strings when inputs are empty', () => {
      const config = panel.getConfig();
      expect(config).toEqual({
        baseURL: '',
        apiKey: '',
        model: ''
      });
    });
  });

  describe('onConfigChange() and save config', () => {
    test('save button triggers configChangeCallback with current config', () => {
      const callback = jest.fn();
      panel.onConfigChange(callback);

      panel.baseURLInput.value = 'https://api.example.com';
      panel.apiKeyInput.value = 'sk-key';
      panel.modelInput.value = 'gpt-4o';

      panel.saveConfigBtn.click();

      expect(callback).toHaveBeenCalledWith({
        baseURL: 'https://api.example.com',
        apiKey: 'sk-key',
        model: 'gpt-4o'
      });
    });

    test('save button does not throw when no callback is registered', () => {
      expect(() => panel.saveConfigBtn.click()).not.toThrow();
    });

    test('onConfigChange replaces previous callback', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      panel.onConfigChange(callback1);
      panel.onConfigChange(callback2);

      panel.saveConfigBtn.click();

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });
  });

  describe('onSubmit() and submit behavior', () => {
    test('calls callback with non-empty text on button click', () => {
      const callback = jest.fn();
      panel.onSubmit(callback);
      panel.inputField.value = 'test command';
      panel.submitBtn.click();

      expect(callback).toHaveBeenCalledWith('test command');
      expect(panel.inputField.value).toBe('');
    });

    test('calls callback on Enter key press', () => {
      const callback = jest.fn();
      panel.onSubmit(callback);
      panel.inputField.value = 'enter command';

      const event = new KeyboardEvent('keydown', { key: 'Enter' });
      panel.inputField.dispatchEvent(event);

      expect(callback).toHaveBeenCalledWith('enter command');
    });

    test('ignores submit when input is blank', () => {
      const callback = jest.fn();
      panel.onSubmit(callback);
      panel.inputField.value = '   ';
      panel.submitBtn.click();

      expect(callback).not.toHaveBeenCalled();
    });

    test('ignores submit when input is empty', () => {
      const callback = jest.fn();
      panel.onSubmit(callback);
      panel.inputField.value = '';
      panel.submitBtn.click();

      expect(callback).not.toHaveBeenCalled();
    });

    test('does not throw when no callback is registered', () => {
      panel.inputField.value = 'test';
      expect(() => panel.submitBtn.click()).not.toThrow();
    });
  });
});
