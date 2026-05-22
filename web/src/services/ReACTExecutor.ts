import { LLMClient, ToolCall } from './LLMClient';
import { RemoteControlClient, ControlCommand } from './RemoteControlClient';

export interface ActionMessage {
  action: Record<string, unknown> | null;
  observation: string | ImageObservation;
}

export interface ImageObservation {
  type: 'image';
  image: string;
  format: string;
}

export interface ChatCallbacks {
  createAssistantMessage: () => string;
  appendStreamingText: (messageId: string, chunk: string, type: 'reasoning' | 'content') => void;
  finalizeAssistantMessage: (messageId: string, fullText: string, fullReasoning: string) => void;
  appendActionMessage: (action: Record<string, unknown> | null, observation: string | ImageObservation) => void;
  setLoading: (loading: boolean) => void;
}

/**
 * ReACTExecutor - 循环执行引擎（支持 Tool Use + ReACT fallback）
 */
export class ReACTExecutor {
  private llmClient: LLMClient;
  private chatCallbacks: ChatCallbacks;
  private remoteClient: RemoteControlClient;
  maxIterations = Infinity;
  isRunning = false;

  constructor(llmClient: LLMClient, chatCallbacks: ChatCallbacks, remoteClient: RemoteControlClient) {
    this.llmClient = llmClient;
    this.chatCallbacks = chatCallbacks;
    this.remoteClient = remoteClient;
  }

  updateCallbacks(callbacks: ChatCallbacks): void {
    this.chatCallbacks = callbacks;
  }

  clampCoordinate(value: number): number {
    return Math.max(0, Math.min(1, value));
  }

  convertToCommand(action: Record<string, unknown>): ControlCommand | null {
    const actionName = (action.action || action.name) as string;
    switch (actionName) {
      case 'tap':
        return {
          type: 'tap',
          x: this.clampCoordinate(action.x as number),
          y: this.clampCoordinate(action.y as number),
          normalized: true,
        };
      case 'swipe':
        return {
          type: 'swipe',
          startX: this.clampCoordinate(action.x as number),
          startY: this.clampCoordinate(action.y as number),
          endX: this.clampCoordinate(((action.x as number) || 0) + ((action.dx as number) || 0)),
          endY: this.clampCoordinate(((action.y as number) || 0) + ((action.dy as number) || 0)),
          normalized: true,
          duration: (action.duration as number) || 0.5,
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
        return { type: 'input', text: (action.text as string) || '', clearText: !!(action.clearText) };
      default:
        return null;
    }
  }

  async handleUserMessage(userText: string): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    this.llmClient.addUserMessage(userText);
    this.chatCallbacks.setLoading(true);

    try {
      let iteration = 0;
      let shouldContinue = true;

      while (shouldContinue && iteration < this.maxIterations) {
        iteration++;
        shouldContinue = await this.executeOneStep();
      }

      if (iteration >= this.maxIterations && shouldContinue) {
        this.chatCallbacks.appendActionMessage(null, '操作步骤超过限制，任务已终止');
      }
    } finally {
      this.isRunning = false;
      this.chatCallbacks.setLoading(false);
    }
  }

  async executeAction(actionName: string, actionArgs: Record<string, unknown>): Promise<string | ImageObservation> {
    try {
      if (actionName === 'screenshot') {
        return await this.takeScreenshot();
      }

      const action = { action: actionName, ...actionArgs };
      const command = this.convertToCommand(action);

      if (command === null) {
        return `未知操作类型：${actionName}`;
      }

      this.remoteClient.sendCommand(command);
      return `操作 ${actionName} 已执行`;
    } catch (error) {
      return `操作执行失败：${(error as Error).message}`;
    }
  }

  async takeScreenshot(): Promise<string | ImageObservation> {
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
      return `截图失败：${(error as Error).message}`;
    }
  }

  async executeOneStep(): Promise<boolean> {
    return new Promise((resolve) => {
      const messageId = this.chatCallbacks.createAssistantMessage();

      this.llmClient.sendStreamingRequest(
        (chunk, type) => {
          this.chatCallbacks.appendStreamingText(messageId, chunk, type);
        },
        async (fullContent, fullReasoning, toolCalls) => {
          this.chatCallbacks.finalizeAssistantMessage(messageId, fullContent, fullReasoning);

          if (toolCalls && toolCalls.length > 0) {
            this.llmClient.addAssistantMessage(fullContent, toolCalls, fullReasoning);

            for (const tc of toolCalls) {
              const funcName = tc.function.name;
              let funcArgs: Record<string, unknown> = {};
              try {
                funcArgs = JSON.parse(tc.function.arguments || '{}');
              } catch { funcArgs = {}; }

              const observation = await this.executeAction(funcName, funcArgs);
              this.chatCallbacks.appendActionMessage({ action: funcName, ...funcArgs }, observation);

              if (typeof observation === 'object' && observation.type === 'image') {
                this.llmClient.addImageToolResult(tc.id, observation.image, observation.format);
              } else {
                this.llmClient.addToolResult(tc.id, observation);
              }

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

            resolve(true);
            return;
          }

          const combinedText = ((fullReasoning || '') + '\n' + (fullContent || '')).trim();
          this.llmClient.addAssistantMessage(fullContent || combinedText, null, fullReasoning);

          const parsed = this.llmClient.parseReACTResponse(combinedText);

          if (parsed.finalAnswer) {
            resolve(false);
            return;
          }

          if (parsed.action) {
            const actionName = parsed.action.action as string;
            const observation = await this.executeAction(actionName, parsed.action);
            this.chatCallbacks.appendActionMessage(parsed.action, observation);

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
        (error) => {
          this.chatCallbacks.finalizeAssistantMessage(messageId, '', '');
          this.chatCallbacks.appendActionMessage(null, `流式响应中断：${error.message}`);
          resolve(false);
        },
      );
    });
  }
}
