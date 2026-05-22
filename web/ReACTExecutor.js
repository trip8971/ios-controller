// ============================================================
// ReACTExecutor - 循环执行引擎（支持 Tool Use + ReACT fallback）
// ============================================================

class ReACTExecutor {
  constructor(llmClient, chatPanel, remoteClient) {
    this.llmClient = llmClient;
    this.chatPanel = chatPanel;
    this.remoteClient = remoteClient;
    this.maxIterations = Infinity;
    this.isRunning = false;
  }

  clampCoordinate(value) {
    return Math.max(0, Math.min(1, value));
  }

  convertToCommand(action) {
    switch (action.action || action.name) {
      case 'tap':
        return {
          type: 'tap',
          x: this.clampCoordinate(action.x),
          y: this.clampCoordinate(action.y),
          normalized: true
        };
      case 'swipe':
        return {
          type: 'swipe',
          startX: this.clampCoordinate(action.x),
          startY: this.clampCoordinate(action.y),
          endX: this.clampCoordinate((action.x || 0) + (action.dx || 0)),
          endY: this.clampCoordinate((action.y || 0) + (action.dy || 0)),
          normalized: true,
          duration: action.duration || 0.5
        };
      case 'volume_up':
        return { type: 'volume_up' };
      case 'volume_down':
        return { type: 'volume_down' };
      case 'home':
        return { type: 'home' };
      case 'screenshot':
        return { type: 'screenshot' };
      case 'input':
        return { type: 'input', text: action.text || '', clearText: !!action.clearText };
      default:
        return null;
    }
  }

  async handleUserMessage(userText) {
    if (this.isRunning) return;
    this.isRunning = true;

    this.llmClient.addUserMessage(userText);
    this.chatPanel.setLoading(true);

    try {
      let iteration = 0;
      let shouldContinue = true;

      while (shouldContinue && iteration < this.maxIterations) {
        iteration++;
        shouldContinue = await this.executeOneStep();
      }

      if (iteration >= this.maxIterations && shouldContinue) {
        this.chatPanel.appendActionMessage(null, '操作步骤超过限制，任务已终止');
      }
    } finally {
      this.isRunning = false;
      this.chatPanel.setLoading(false);
    }
  }

  async executeAction(actionName, actionArgs) {
    try {
      if (actionName === 'screenshot') {
        return await this.takeScreenshot();
      }

      // Build action object for convertToCommand
      const action = { action: actionName, ...actionArgs };
      const command = this.convertToCommand(action);

      if (command === null) {
        return `未知操作类型：${actionName}`;
      }

      this.remoteClient.sendCommand(command);
      return `操作 ${actionName} 已执行`;
    } catch (error) {
      return `操作执行失败：${error.message}`;
    }
  }

  async takeScreenshot() {
    try {
      const apiBase = this.llmClient.apiBase || '';
      const response = await fetch(apiBase + '/api/screenshot');

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        return `截图失败：${errorData.error || response.statusText}`;
      }

      const data = await response.json();

      if (data.success && data.image) {
        return { type: 'image', image: data.image, format: data.format || 'png' };
      } else {
        return `截图失败：${data.error || '未知错误'}`;
      }
    } catch (error) {
      return `截图失败：${error.message}`;
    }
  }

  /**
   * 执行单轮：发送请求 → 处理 tool_calls 或文本响应
   * @returns {Promise<boolean>} 是否继续循环
   */
  async executeOneStep() {
    return new Promise((resolve) => {
      const messageId = this.chatPanel.createAssistantMessage();

      this.llmClient.sendStreamingRequest(
        // onChunk
        (chunk, type) => {
          this.chatPanel.appendStreamingText(messageId, chunk, type);
        },
        // onComplete
        async (fullContent, fullReasoning, toolCalls) => {
          this.chatPanel.finalizeAssistantMessage(messageId, fullContent, fullReasoning);

          // === Tool Use 模式 ===
          if (toolCalls && toolCalls.length > 0) {
            // 添加助手消息（含 tool_calls）到历史
            this.llmClient.addAssistantMessage(fullContent, toolCalls, fullReasoning);

            // 顺序执行每个 tool call，失败时停止后续调用
            for (const tc of toolCalls) {
              const funcName = tc.function.name;
              let funcArgs = {};
              try {
                funcArgs = JSON.parse(tc.function.arguments || '{}');
              } catch (e) {
                funcArgs = {};
              }

              const observation = await this.executeAction(funcName, funcArgs);
              this.chatPanel.appendActionMessage({ action: funcName, ...funcArgs }, observation);

              // 添加 tool result 到历史
              if (typeof observation === 'object' && observation.type === 'image') {
                this.llmClient.addImageToolResult(tc.id, observation.image, observation.format);
              } else {
                this.llmClient.addToolResult(tc.id, observation);
              }

              // 如果执行失败，跳过剩余 tool calls（给未执行的也填充错误结果）
              const failed = typeof observation === 'string' && (
                observation.includes('失败') || observation.includes('错误') || observation.includes('未知')
              );
              if (failed) {
                const remaining = toolCalls.slice(toolCalls.indexOf(tc) + 1);
                for (const skipped of remaining) {
                  this.llmClient.addToolResult(skipped.id, '已跳过：前一个操作执行失败');
                }
                break;
              }
            }

            resolve(true); // 继续循环
            return;
          }

          // === ReACT 文本 fallback（模型不支持 tool use 时）===
          const combinedText = ((fullReasoning || '') + '\n' + (fullContent || '')).trim();
          this.llmClient.addAssistantMessage(fullContent || combinedText, null, fullReasoning);

          const parsed = this.llmClient.parseReACTResponse(combinedText);

          if (parsed.finalAnswer) {
            resolve(false);
            return;
          }

          if (parsed.action) {
            const actionName = parsed.action.action;
            const observation = await this.executeAction(actionName, parsed.action);
            this.chatPanel.appendActionMessage(parsed.action, observation);

            if (typeof observation === 'object' && observation.type === 'image') {
              this.llmClient.addImageObservation(observation.image, observation.format);
            } else {
              this.llmClient.addObservation(typeof observation === 'string' ? observation : JSON.stringify(observation));
            }

            resolve(true);
          } else {
            resolve(false);
          }
        },
        // onError
        (error) => {
          this.chatPanel.finalizeAssistantMessage(messageId, '', '');
          this.chatPanel.appendActionMessage(null, `流式响应中断：${error.message}`);
          resolve(false);
        }
      );
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ReACTExecutor;
}
