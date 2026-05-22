// ============================================================
// LLMClient - LLM 对话上下文管理（Tool Use 模式）
// ============================================================

/**
 * LLMClient - LLM 客户端
 *
 * 使用 OpenAI Function Calling / Tool Use 模式与 LLM 交互。
 * LLM 通过 tool_calls 返回结构化操作指令，无需文本解析。
 */
class LLMClient {
  constructor() {
    /** @type {Array<Object>} 对话历史消息数组 */
    this.conversationHistory = [];

    /** @type {{ baseURL: string, apiKey: string, model: string }} LLM 配置 */
    this.config = { baseURL: '', apiKey: '', model: '' };

    /** @type {string} Server API base URL (e.g., 'http://localhost:8080') */
    this.apiBase = '';

    this.initSystemPrompt();
  }

  /**
   * 工具定义（OpenAI tools 格式）
   */
  static get TOOLS() {
    return [
      {
        type: 'function',
        function: {
          name: 'tap',
          description: '点击屏幕指定位置。x 和 y 为 0-1 之间的归一化坐标，(0,0) 为左上角，(1,1) 为右下角。',
          parameters: {
            type: 'object',
            properties: {
              x: { type: 'number', description: '归一化 x 坐标 (0-1)' },
              y: { type: 'number', description: '归一化 y 坐标 (0-1)' }
            },
            required: ['x', 'y']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'swipe',
          description: '滑动屏幕。x/y 为起点归一化坐标(0-1)，dx/dy 为偏移量(-1到1)。dx>0向右，dx<0向左；dy>0向下，dy<0向上。例如从屏幕中心向上滑：x=0.5,y=0.5,dx=0,dy=-0.3',
          parameters: {
            type: 'object',
            properties: {
              x: { type: 'number', description: '起点 x 坐标 (0-1)' },
              y: { type: 'number', description: '起点 y 坐标 (0-1)' },
              dx: { type: 'number', description: 'x 方向偏移量 (-1到1)' },
              dy: { type: 'number', description: 'y 方向偏移量 (-1到1)' },
              duration: { type: 'number', description: '滑动时长（秒），默认 0.5' }
            },
            required: ['x', 'y', 'dx', 'dy']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'volume_up',
          description: '增大音量',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'volume_down',
          description: '减小音量',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'home',
          description: '按下 Home 键，返回主屏幕',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'screenshot',
          description: '截取当前屏幕画面，返回图片供观察屏幕状态。每次执行操作后应主动截图确认结果。',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'input',
          description: '在当前焦点输入框中输入文本。使用前必须先用 tap 点击目标输入框使其获得键盘焦点。',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '要输入的文本' },
              clearText: { type: 'boolean', description: '是否先清空输入框再输入，默认 false' }
            },
            required: ['text']
          }
        }
      }
    ];
  }

  /**
   * 初始化 System Prompt
   */
  initSystemPrompt() {
    const systemPromptText = `你是一个手机操控助手，通过工具调用来控制一台 iOS 手机。

工作流程：
1. 先调用 screenshot 观察当前屏幕状态
2. 根据截图内容决定操作（tap、swipe、input 等）
3. 操作后再次 screenshot 确认结果
4. 重复以上步骤直到任务完成

重要规则：
- 可以一次调用多个工具，系统会按顺序执行，前一个成功后才执行下一个
- 每次操作后主动 screenshot 确认结果
- 使用 input 前必须先 tap 点击目标输入框使其获得焦点
- 坐标使用 0 到 1 之间的归一化值，(0,0) 左上角，(1,1) 右下角
- 如果工具调用失败，根据返回的错误信息调整策略重试
- 任务完成后用普通文本回复用户（不调用工具即表示任务结束）`;

    this.conversationHistory.push({
      role: 'system',
      content: systemPromptText
    });
  }

  addUserMessage(text) {
    this.conversationHistory.push({ role: 'user', content: text });
  }

  /**
   * 添加助手消息到对话历史（可能包含 tool_calls 和 reasoning_content）
   */
  addAssistantMessage(content, toolCalls, reasoningContent) {
    const msg = { role: 'assistant', content: content || null };
    if (toolCalls && toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
    }
    // 某些模型（如 qwen thinking 模式）要求 assistant 消息保留 reasoning_content
    if (reasoningContent) {
      msg.reasoning_content = reasoningContent;
    }
    this.conversationHistory.push(msg);
  }

  /**
   * 添加工具调用结果到对话历史
   */
  addToolResult(toolCallId, content) {
    this.conversationHistory.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: typeof content === 'string' ? content : JSON.stringify(content)
    });
  }

  /**
   * 添加包含图片的工具结果
   */
  addImageToolResult(toolCallId, base64Image, format) {
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    this.conversationHistory.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: [
        { type: 'text', text: '当前屏幕截图：' },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
      ]
    });
  }

  addObservation(content) {
    this.conversationHistory.push({ role: 'user', content: content });
  }

  addImageObservation(base64Image, format) {
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    this.conversationHistory.push({
      role: 'user',
      content: [
        { type: 'text', text: 'Observation: 以下是当前屏幕截图' },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
      ]
    });
  }

  clearHistory() {
    this.conversationHistory = [];
    this.initSystemPrompt();
  }

  updateConfig(config) {
    Object.assign(this.config, config);
  }

  /**
   * 解析单行 SSE 数据，支持 content、reasoning_content 和 tool_calls
   */
  static parseSSELine(line) {
    if (!line.startsWith('data: ')) {
      return { done: false, content: null, reasoning: null, toolCalls: null };
    }

    const data = line.slice(6);

    if (data === '[DONE]') {
      return { done: true, content: null, reasoning: null, toolCalls: null };
    }

    try {
      const parsed = JSON.parse(data);
      const choice = parsed.choices && parsed.choices[0];
      if (!choice) return { done: false, content: null, reasoning: null, toolCalls: null };

      const delta = choice.delta || {};
      const reasoning = delta.reasoning_content || null;
      const content = delta.content || null;

      // Tool calls in streaming come as delta.tool_calls
      const toolCalls = delta.tool_calls || null;

      return { done: false, content, reasoning, toolCalls };
    } catch (e) {
      return { done: false, content: null, reasoning: null, toolCalls: null };
    }
  }

  /**
   * parseReACTResponse 保留作为 fallback（当模型不支持 tool use 时）
   */
  parseReACTResponse(text) {
    const result = { thought: undefined, action: undefined, finalAnswer: undefined, raw: text };
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    cleaned = cleaned.replace(/^---$/gm, '').trim();
    const parseText = cleaned || text;

    const thoughtMatch = parseText.match(/Thought:([\s\S]*?)(?=Action:|Final Answer:|$)/);
    const actionMatch = parseText.match(/Action:([\s\S]*?)(?=Thought:|Final Answer:|$)/);
    const finalAnswerMatch = parseText.match(/Final Answer:([\s\S]*?)(?=Thought:|Action:|$)/);

    if (thoughtMatch) result.thought = thoughtMatch[1].trim();
    if (actionMatch) {
      const jsonMatch = actionMatch[1].trim().match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        try { result.action = JSON.parse(jsonMatch[0]); } catch (e) {}
      }
    }
    if (finalAnswerMatch) result.finalAnswer = finalAnswerMatch[1].trim();

    if (!thoughtMatch && !actionMatch && !finalAnswerMatch) {
      const rawJson = parseText.trim().match(/^\{[\s\S]*\}$/);
      if (rawJson) {
        try {
          const parsed = JSON.parse(rawJson[0]);
          if (parsed.action) { result.action = parsed; return result; }
        } catch (e) {}
      }
      result.finalAnswer = parseText.trim() || undefined;
    }
    return result;
  }

  /**
   * 发送流式请求，支持 tool_calls 和 content/reasoning
   * @param {Function} onChunk - (text, type) type='reasoning'|'content'
   * @param {Function} onComplete - (fullContent, fullReasoning, toolCalls)
   * @param {Function} onError - (error)
   */
  async sendStreamingRequest(onChunk, onComplete, onError) {
    try {
      const requestBody = {
        messages: this.conversationHistory,
        stream: true,
        config: this.config,
        tools: LLMClient.TOOLS,
        tool_choice: 'auto'
      };

      const apiBase = this.apiBase || '';
      const response = await fetch(apiBase + '/api/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        onError(new Error(`LLM request failed: ${response.status} ${errorText}`));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullReasoning = '';
      let fullContent = '';
      let inThinkTag = false;

      // Accumulate streaming tool_calls
      // Each tool call comes in pieces: {index, id, type, function: {name, arguments}}
      const toolCallsMap = {};

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          const toolCalls = this._buildToolCalls(toolCallsMap);
          onComplete(fullContent, fullReasoning, toolCalls);
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine === '') continue;

          const result = LLMClient.parseSSELine(trimmedLine);

          if (result.done) {
            const toolCalls = this._buildToolCalls(toolCallsMap);
            onComplete(fullContent, fullReasoning, toolCalls);
            return;
          }

          // Accumulate tool_calls
          if (result.toolCalls) {
            for (const tc of result.toolCalls) {
              const idx = tc.index;
              if (!toolCallsMap[idx]) {
                toolCallsMap[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
              }
              if (tc.id) toolCallsMap[idx].id = tc.id;
              if (tc.type) toolCallsMap[idx].type = tc.type;
              if (tc.function) {
                if (tc.function.name) toolCallsMap[idx].function.name += tc.function.name;
                if (tc.function.arguments) toolCallsMap[idx].function.arguments += tc.function.arguments;
              }
            }
          }

          if (result.reasoning) {
            fullReasoning += result.reasoning;
            onChunk(result.reasoning, 'reasoning');
          }

          if (result.content) {
            let text = result.content;
            while (text.length > 0) {
              if (inThinkTag) {
                const closeIdx = text.indexOf('</think>');
                if (closeIdx !== -1) {
                  const rp = text.substring(0, closeIdx);
                  if (rp) { fullReasoning += rp; onChunk(rp, 'reasoning'); }
                  inThinkTag = false;
                  text = text.substring(closeIdx + 8);
                } else {
                  fullReasoning += text; onChunk(text, 'reasoning'); text = '';
                }
              } else {
                const openIdx = text.indexOf('<think>');
                if (openIdx !== -1) {
                  const cp = text.substring(0, openIdx);
                  if (cp) { fullContent += cp; onChunk(cp, 'content'); }
                  inThinkTag = true;
                  text = text.substring(openIdx + 7);
                } else {
                  fullContent += text; onChunk(text, 'content'); text = '';
                }
              }
            }
          }
        }
      }
    } catch (error) {
      onError(error);
    }
  }

  /**
   * 将累积的 tool_calls map 转为数组
   */
  _buildToolCalls(map) {
    const keys = Object.keys(map);
    if (keys.length === 0) return null;
    return keys.sort((a, b) => a - b).map(k => map[k]);
  }
}

// ============================================================
// 模块导出
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LLMClient;
}
