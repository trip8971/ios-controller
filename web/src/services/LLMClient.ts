/**
 * LLMClient - LLM 客户端
 *
 * 使用 OpenAI Function Calling / Tool Use 模式与 LLM 交互。
 * LLM 通过 tool_calls 返回结构化操作指令，无需文本解析。
 */

export interface LLMConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface ToolDefinition {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface SSEParseResult {
  done: boolean;
  content: string | null;
  reasoning: string | null;
  toolCalls: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> | null;
}

export interface ReACTParseResult {
  thought?: string;
  action?: Record<string, unknown>;
  finalAnswer?: string;
  raw: string;
}

type ConversationMessage = Record<string, unknown>;

export class LLMClient {
  conversationHistory: ConversationMessage[] = [];
  config: LLMConfig = { baseURL: '', apiKey: '', model: '' };
  apiBase = '';

  constructor() {
    this.initSystemPrompt();
  }

  static get TOOLS(): ToolDefinition[] {
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
              y: { type: 'number', description: '归一化 y 坐标 (0-1)' },
            },
            required: ['x', 'y'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'swipe',
          description: '滑动屏幕。x/y 为起点归一化坐标(0-1)，dx/dy 为偏移量(-1到1)。',
          parameters: {
            type: 'object',
            properties: {
              x: { type: 'number', description: '起点 x 坐标 (0-1)' },
              y: { type: 'number', description: '起点 y 坐标 (0-1)' },
              dx: { type: 'number', description: 'x 方向偏移量 (-1到1)' },
              dy: { type: 'number', description: 'y 方向偏移量 (-1到1)' },
              duration: { type: 'number', description: '滑动时长（秒），默认 0.5' },
            },
            required: ['x', 'y', 'dx', 'dy'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'volume_up',
          description: '增大音量',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'volume_down',
          description: '减小音量',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'home',
          description: '按下 Home 键，返回主屏幕',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'screenshot',
          description: '截取当前屏幕画面，返回图片供观察屏幕状态。每次执行操作后应主动截图确认结果。',
          parameters: { type: 'object', properties: {} },
        },
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
              clearText: { type: 'boolean', description: '是否先清空输入框再输入，默认 false' },
            },
            required: ['text'],
          },
        },
      },
    ];
  }

  initSystemPrompt(): void {
    const systemPromptText = `你是一个手机操控助手，通过工具调用来控制一台 iOS 手机。

核心原则：尽量减少交互轮次，一次调用中尽可能多地发出工具调用。

工作流程：
1. 先 screenshot 观察当前屏幕
2. 规划接下来的操作序列，将确定性操作批量发出
3. 在需要观察屏幕变化时再 screenshot

批量操作策略：
- 对于确定性的连续操作（如 tap 某按钮 → 等待页面切换 → tap 下一个按钮），直接一次性发出所有 tool_calls，无需在中间插入 screenshot
- 例如"打开设置 → 点击通用"可以一次发出：tap(设置图标) + tap(通用)
- 例如"在搜索框输入文字"可以一次发出：tap(搜索框) + input(文字)

何时需要 screenshot：
- 任务开始时，需要了解当前屏幕状态
- 操作结果不确定时（如不确定页面是否已切换、元素位置是否变化）
- 连续操作序列执行完毕后，需要确认最终结果
- 操作失败需要重新观察时
- 不需要在每个操作后都截图

重要规则：
- 坐标使用 0 到 1 之间的归一化值，(0,0) 左上角，(1,1) 右下角
- 使用 input 前必须先 tap 点击目标输入框使其获得焦点（可在同一次调用中）
- 如果工具调用失败，screenshot 观察后调整策略重试
- 任务完成后用普通文本回复用户（不调用工具即表示任务结束）`;

    this.conversationHistory.push({ role: 'system', content: systemPromptText });
  }

  addUserMessage(text: string): void {
    this.conversationHistory.push({ role: 'user', content: text });
  }

  addAssistantMessage(content: string | null, toolCalls?: ToolCall[] | null, reasoningContent?: string): void {
    const msg: ConversationMessage = { role: 'assistant', content: content || null };
    if (toolCalls && toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
    }
    if (reasoningContent) {
      msg.reasoning_content = reasoningContent;
    }
    this.conversationHistory.push(msg);
  }

  addToolResult(toolCallId: string, content: unknown): void {
    this.conversationHistory.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    });
  }

  addImageToolResult(toolCallId: string, base64Image: string, format: string): void {
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    this.conversationHistory.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: [
        { type: 'text', text: '当前屏幕截图：' },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
      ],
    });
  }

  addObservation(content: string): void {
    this.conversationHistory.push({ role: 'user', content });
  }

  addImageObservation(base64Image: string, format: string): void {
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    this.conversationHistory.push({
      role: 'user',
      content: [
        { type: 'text', text: 'Observation: 以下是当前屏幕截图' },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
      ],
    });
  }

  clearHistory(): void {
    this.conversationHistory = [];
    this.initSystemPrompt();
  }

  updateConfig(config: Partial<LLMConfig>): void {
    Object.assign(this.config, config);
  }

  static parseSSELine(line: string): SSEParseResult {
    if (!line.startsWith('data: ')) {
      return { done: false, content: null, reasoning: null, toolCalls: null };
    }

    const data = line.slice(6);
    if (data === '[DONE]') {
      return { done: true, content: null, reasoning: null, toolCalls: null };
    }

    try {
      const parsed = JSON.parse(data);
      const choice = parsed.choices?.[0];
      if (!choice) return { done: false, content: null, reasoning: null, toolCalls: null };

      const delta = choice.delta || {};
      const reasoning = delta.reasoning_content || null;
      const content = delta.content || null;
      const toolCalls = delta.tool_calls || null;

      return { done: false, content, reasoning, toolCalls };
    } catch {
      return { done: false, content: null, reasoning: null, toolCalls: null };
    }
  }

  parseReACTResponse(text: string): ReACTParseResult {
    const result: ReACTParseResult = { raw: text };
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
        try { result.action = JSON.parse(jsonMatch[0]); } catch { /* ignore */ }
      }
    }
    if (finalAnswerMatch) result.finalAnswer = finalAnswerMatch[1].trim();

    if (!thoughtMatch && !actionMatch && !finalAnswerMatch) {
      const rawJson = parseText.trim().match(/^\{[\s\S]*\}$/);
      if (rawJson) {
        try {
          const parsed = JSON.parse(rawJson[0]);
          if (parsed.action) { result.action = parsed; return result; }
        } catch { /* ignore */ }
      }
      result.finalAnswer = parseText.trim() || undefined;
    }
    return result;
  }

  async sendStreamingRequest(
    onChunk: (text: string, type: 'reasoning' | 'content') => void,
    onComplete: (fullContent: string, fullReasoning: string, toolCalls: ToolCall[] | null) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    try {
      const requestBody = {
        messages: this.conversationHistory,
        stream: true,
        config: this.config,
        tools: LLMClient.TOOLS,
        tool_choice: 'auto',
      };

      const apiBase = this.apiBase || '';
      const response = await fetch(apiBase + '/api/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        onError(new Error(`LLM request failed: ${response.status} ${errorText}`));
        return;
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullReasoning = '';
      let fullContent = '';
      let inThinkTag = false;

      const toolCallsMap: Record<number, ToolCall> = {};

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          const toolCalls = this._buildToolCalls(toolCallsMap);
          onComplete(fullContent, fullReasoning, toolCalls);
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine === '') continue;

          const result = LLMClient.parseSSELine(trimmedLine);

          if (result.done) {
            const toolCalls = this._buildToolCalls(toolCallsMap);
            onComplete(fullContent, fullReasoning, toolCalls);
            return;
          }

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
      onError(error as Error);
    }
  }

  private _buildToolCalls(map: Record<number, ToolCall>): ToolCall[] | null {
    const keys = Object.keys(map);
    if (keys.length === 0) return null;
    return keys.sort((a, b) => Number(a) - Number(b)).map(k => map[Number(k)]);
  }
}
