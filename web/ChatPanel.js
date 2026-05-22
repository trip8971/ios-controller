class ChatPanel {
  /**
   * @param {HTMLElement} container - 面板容器元素
   */
  constructor(container) {
    this.container = container;
    this.messageIdCounter = 0;
    this.messages = {}; // messageId → { element, textSpan, cursor }
    this.submitCallback = null;
    this.configChangeCallback = null;

    this._createDOM();
    this._loadConfig();
  }

  _createDOM() {
    // Create settings area
    this.settingsArea = document.createElement('div');
    this.settingsArea.className = 'chat-settings';

    // Toggle button to show/hide settings
    this.settingsToggle = document.createElement('button');
    this.settingsToggle.className = 'chat-settings-toggle';
    this.settingsToggle.textContent = '⚙️ 设置';
    this.settingsToggle.addEventListener('click', () => {
      this.settingsContent.classList.toggle('hidden');
    });

    // Settings content (initially hidden)
    this.settingsContent = document.createElement('div');
    this.settingsContent.className = 'chat-settings-content hidden';

    // baseURL input
    this.baseURLInput = document.createElement('input');
    this.baseURLInput.type = 'text';
    this.baseURLInput.className = 'chat-settings-input';
    this.baseURLInput.placeholder = 'API Base URL';

    // API Key input
    this.apiKeyInput = document.createElement('input');
    this.apiKeyInput.type = 'password';
    this.apiKeyInput.className = 'chat-settings-input';
    this.apiKeyInput.placeholder = 'API Key';

    // Model input
    this.modelInput = document.createElement('input');
    this.modelInput.type = 'text';
    this.modelInput.className = 'chat-settings-input';
    this.modelInput.placeholder = '模型名称 (如 gpt-4o)';

    // Save button
    this.saveConfigBtn = document.createElement('button');
    this.saveConfigBtn.className = 'chat-settings-save';
    this.saveConfigBtn.textContent = '保存配置';
    this.saveConfigBtn.addEventListener('click', () => this._handleSaveConfig());

    // Assemble settings
    this.settingsContent.appendChild(this.baseURLInput);
    this.settingsContent.appendChild(this.apiKeyInput);
    this.settingsContent.appendChild(this.modelInput);
    this.settingsContent.appendChild(this.saveConfigBtn);

    this.settingsArea.appendChild(this.settingsToggle);
    this.settingsArea.appendChild(this.settingsContent);

    // Create message list container
    this.messageList = document.createElement('div');
    this.messageList.className = 'chat-message-list';

    // Create input area
    this.inputArea = document.createElement('div');
    this.inputArea.className = 'chat-input-area';

    this.inputField = document.createElement('input');
    this.inputField.type = 'text';
    this.inputField.className = 'chat-input';
    this.inputField.placeholder = '输入指令...';

    this.submitBtn = document.createElement('button');
    this.submitBtn.className = 'chat-submit-btn';
    this.submitBtn.textContent = '发送';

    this.loadingIndicator = document.createElement('span');
    this.loadingIndicator.className = 'chat-loading hidden';
    this.loadingIndicator.textContent = '处理中...';

    this.inputArea.appendChild(this.inputField);
    this.inputArea.appendChild(this.submitBtn);
    this.inputArea.appendChild(this.loadingIndicator);

    // Settings first, then message list, then input area
    this.container.appendChild(this.settingsArea);
    this.container.appendChild(this.messageList);
    this.container.appendChild(this.inputArea);

    // Bind submit events
    this.submitBtn.addEventListener('click', () => this._handleSubmit());
    this.inputField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._handleSubmit();
    });
  }

  _handleSubmit() {
    const text = this.getAndClearInput();
    if (text && this.submitCallback) {
      this.submitCallback(text);
    }
  }

  /**
   * 追加用户消息到消息列表
   * @param {string} text
   */
  appendUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'chat-message user-message';
    el.textContent = text;
    this.messageList.appendChild(el);
    this._scrollToBottom();
  }

  /**
   * 创建助手消息占位，返回消息 ID 用于后续更新
   * @returns {string} messageId
   */
  createAssistantMessage() {
    const id = 'msg-' + (++this.messageIdCounter);
    const el = document.createElement('div');
    el.className = 'chat-message assistant-message';

    // Thinking/reasoning area (collapsible)
    const reasoningBlock = document.createElement('div');
    reasoningBlock.className = 'reasoning-block hidden';

    const reasoningToggle = document.createElement('div');
    reasoningToggle.className = 'reasoning-toggle';
    reasoningToggle.textContent = '💭 思考过程';
    reasoningToggle.addEventListener('click', () => {
      reasoningContent.classList.toggle('collapsed');
      reasoningToggle.classList.toggle('expanded');
    });

    const reasoningContent = document.createElement('div');
    reasoningContent.className = 'reasoning-content';

    reasoningBlock.appendChild(reasoningToggle);
    reasoningBlock.appendChild(reasoningContent);

    // Main content area
    const textSpan = document.createElement('span');
    textSpan.className = 'message-text';

    const cursor = document.createElement('span');
    cursor.className = 'streaming-cursor';

    el.appendChild(reasoningBlock);
    el.appendChild(textSpan);
    el.appendChild(cursor);

    this.messageList.appendChild(el);
    this.messages[id] = { element: el, textSpan, cursor, reasoningBlock, reasoningContent };
    this._scrollToBottom();
    return id;
  }

  /**
   * 追加流式文本到指定助手消息
   * @param {string} messageId
   * @param {string} chunk
   */
  appendStreamingText(messageId, chunk, type) {
    const msg = this.messages[messageId];
    if (!msg) return;

    if (type === 'reasoning') {
      // Show reasoning block and append to it
      msg.reasoningBlock.classList.remove('hidden');
      msg.reasoningContent.textContent += chunk;
    } else {
      // Default: append to main content
      msg.textSpan.textContent += chunk;
    }
    this._scrollToBottom();
  }

  /**
   * 完成助手消息的流式显示，移除光标指示器
   * @param {string} messageId
   * @param {string} fullText
   */
  finalizeAssistantMessage(messageId, fullText, fullReasoning) {
    const msg = this.messages[messageId];
    if (!msg) return;

    // Render reasoning if present
    if (fullReasoning && msg.reasoningContent) {
      msg.reasoningBlock.classList.remove('hidden');
      msg.reasoningContent.innerHTML = this._renderMarkdown(fullReasoning);
    }

    // Render main content
    msg.textSpan.innerHTML = this._renderMarkdown(fullText);

    if (msg.cursor && msg.cursor.parentNode) {
      msg.cursor.parentNode.removeChild(msg.cursor);
    }
  }

  /**
   * 简易 Markdown 渲染（支持常用格式）
   * @param {string} text
   * @returns {string} HTML
   */
  _renderMarkdown(text) {
    if (!text) return '';
    let html = text
      // Escape HTML entities first
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Code blocks (```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

    // Unordered lists
    html = html.replace(/^\- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Line breaks (preserve newlines outside of pre blocks)
    html = html.replace(/\n/g, '<br>');

    // Clean up extra <br> inside pre blocks
    html = html.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (match, code) => {
      return '<pre><code>' + code.replace(/<br>/g, '\n') + '</code></pre>';
    });

    return html;
  }

  /**
   * 追加 Action/Observation 消息
   * @param {Object} action
   * @param {*} observation
   */
  appendActionMessage(action, observation) {
    const el = document.createElement('div');
    el.className = 'chat-message action-message';

    if (action) {
      const actionText = document.createElement('div');
      actionText.className = 'action-text';
      actionText.textContent = 'Action: ' + JSON.stringify(action);
      el.appendChild(actionText);
    }

    const obsText = document.createElement('div');
    obsText.className = 'observation-text';
    if (typeof observation === 'object' && observation !== null && observation.type === 'image') {
      obsText.textContent = 'Observation: [截图已获取]';
    } else {
      obsText.textContent = typeof observation === 'string' ? observation : JSON.stringify(observation);
    }
    el.appendChild(obsText);

    this.messageList.appendChild(el);
    this._scrollToBottom();
  }

  /**
   * 设置输入框禁用状态和加载指示器
   * @param {boolean} isLoading
   */
  setLoading(isLoading) {
    this.inputField.disabled = isLoading;
    this.submitBtn.disabled = isLoading;
    if (isLoading) {
      this.loadingIndicator.classList.remove('hidden');
    } else {
      this.loadingIndicator.classList.add('hidden');
    }
  }

  /**
   * 清空所有消息
   */
  clearMessages() {
    this.messageList.innerHTML = '';
    this.messages = {};
  }

  /**
   * 获取用户输入文本并清空输入框
   * @returns {string}
   */
  getAndClearInput() {
    const text = this.inputField.value.trim();
    this.inputField.value = '';
    return text || '';
  }

  /**
   * 注册提交回调
   * @param {Function} callback
   */
  onSubmit(callback) {
    this.submitCallback = callback;
  }

  _scrollToBottom() {
    this.messageList.scrollTop = this.messageList.scrollHeight;
  }

  /**
   * 获取当前 LLM 配置
   * @returns {{ baseURL: string, apiKey: string, model: string }}
   */
  getConfig() {
    return {
      baseURL: this.baseURLInput.value.trim(),
      apiKey: this.apiKeyInput.value.trim(),
      model: this.modelInput.value.trim()
    };
  }

  /**
   * 处理保存配置按钮点击
   */
  _handleSaveConfig() {
    if (this.configChangeCallback) {
      this.configChangeCallback(this.getConfig());
    }
    this._saveConfig();
    // Visual feedback
    const originalText = this.saveConfigBtn.textContent;
    this.saveConfigBtn.textContent = '✓ 已保存';
    this.saveConfigBtn.disabled = true;
    setTimeout(() => {
      this.saveConfigBtn.textContent = originalText;
      this.saveConfigBtn.disabled = false;
    }, 1500);
  }

  /**
   * 从 localStorage 加载配置并填充输入框
   */
  _loadConfig() {
    try {
      const saved = localStorage.getItem('llm_config');
      if (saved) {
        const config = JSON.parse(saved);
        if (config.baseURL) this.baseURLInput.value = config.baseURL;
        if (config.apiKey) this.apiKeyInput.value = config.apiKey;
        if (config.model) this.modelInput.value = config.model;
      }
    } catch (e) {
      // ignore localStorage errors
    }
  }

  /**
   * 保存配置到 localStorage
   */
  _saveConfig() {
    try {
      localStorage.setItem('llm_config', JSON.stringify(this.getConfig()));
    } catch (e) {
      // ignore localStorage errors
    }
  }

  /**
   * 注册配置变更回调
   * @param {Function} callback
   */
  onConfigChange(callback) {
    this.configChangeCallback = callback;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatPanel;
}
