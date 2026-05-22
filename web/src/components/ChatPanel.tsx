import { useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import type { ImageObservation } from '../services/ReACTExecutor';

// ============================================================
// Types
// ============================================================

export interface ChatPanelHandle {
  createAssistantMessage: () => string;
  appendStreamingText: (messageId: string, chunk: string, type: 'reasoning' | 'content') => void;
  finalizeAssistantMessage: (messageId: string, fullText: string, fullReasoning: string) => void;
  appendActionMessage: (action: Record<string, unknown> | null, observation: string | ImageObservation) => void;
  setLoading: (loading: boolean) => void;
  appendUserMessage: (text: string) => void;
  clearMessages: () => void;
}

interface ChatMessage {
  id: string;
  type: 'user' | 'assistant' | 'action';
  content: string;
  reasoning?: string;
  reasoningHtml?: string;
  contentHtml?: string;
  isStreaming?: boolean;
  streamingReasoning?: string;
  streamingContent?: string;
  action?: Record<string, unknown> | null;
  observation?: string;
}

interface LLMConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

interface ChatPanelProps {
  onSubmit: (text: string) => void;
  onConfigChange: (config: LLMConfig) => void;
}

// ============================================================
// Markdown renderer (simple)
// ============================================================

function renderMarkdown(text: string): string {
  if (!text) return '';
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^\- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_match, code: string) => {
    return '<pre><code>' + code.replace(/<br>/g, '\n') + '</code></pre>';
  });

  return html;
}

// ============================================================
// Sub-components
// ============================================================

function ReasoningBlock({ reasoning, reasoningHtml }: { reasoning?: string; reasoningHtml?: string }) {
  const [expanded, setExpanded] = useState(true);

  if (!reasoning && !reasoningHtml) return null;

  return (
    <div className="reasoning-block">
      <div
        className={`reasoning-toggle${expanded ? ' expanded' : ''}`}
        onClick={() => setExpanded(!expanded)}
      >
        💭 思考过程
      </div>
      {expanded && (
        <div
          className="reasoning-content"
          dangerouslySetInnerHTML={{ __html: reasoningHtml || reasoning || '' }}
        />
      )}
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.type === 'user') {
    return <div className="chat-message user-message">{msg.content}</div>;
  }

  if (msg.type === 'action') {
    return (
      <div className="chat-message action-message">
        {msg.action && (
          <div className="action-text">▸ {JSON.stringify(msg.action)}</div>
        )}
        <div className="observation-text">{msg.observation}</div>
      </div>
    );
  }

  // assistant
  return (
    <div className="chat-message assistant-message">
      <ReasoningBlock
        reasoning={msg.streamingReasoning || msg.reasoning}
        reasoningHtml={msg.reasoningHtml}
      />
      {msg.isStreaming ? (
        <span className="message-text">
          {msg.streamingContent}
          <span className="streaming-cursor" />
        </span>
      ) : (
        <span
          className="message-text"
          dangerouslySetInnerHTML={{ __html: msg.contentHtml || msg.content }}
        />
      )}
    </div>
  );
}

// ============================================================
// Settings Panel
// ============================================================

function SettingsPanel({ onConfigChange }: { onConfigChange: (config: LLMConfig) => void }) {
  const [visible, setVisible] = useState(false);
  const [baseURL, setBaseURL] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('llm_config');
      if (raw) {
        const config = JSON.parse(raw);
        if (config.baseURL) setBaseURL(config.baseURL);
        if (config.apiKey) setApiKey(config.apiKey);
        if (config.model) setModel(config.model);
        if (config.baseURL || config.apiKey || config.model) {
          onConfigChange({
            baseURL: config.baseURL || '',
            apiKey: config.apiKey || '',
            model: config.model || '',
          });
        }
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = () => {
    const config = { baseURL, apiKey, model };
    onConfigChange(config);
    try {
      localStorage.setItem('llm_config', JSON.stringify(config));
    } catch { /* ignore */ }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="chat-settings">
      <button className="chat-settings-toggle" onClick={() => setVisible(!visible)}>
        {visible ? '⚙ 收起设置' : '⚙ 设置'}
      </button>
      {visible && (
        <div className="chat-settings-content">
          <input
            type="text"
            className="chat-settings-input"
            placeholder="API Base URL"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
          />
          <input
            type="password"
            className="chat-settings-input"
            placeholder="API Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <input
            type="text"
            className="chat-settings-input"
            placeholder="模型名称 (如 gpt-4o)"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <button className="chat-settings-save" onClick={handleSave} disabled={saved}>
            {saved ? '✓ 已保存' : '保存配置'}
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Main ChatPanel Component
// ============================================================

const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel(
  { onSubmit, onConfigChange },
  ref,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messageListRef = useRef<HTMLDivElement>(null);
  const idCounter = useRef(0);

  const scrollToBottom = useCallback(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useImperativeHandle(ref, () => ({
    createAssistantMessage: () => {
      const id = 'msg-' + (++idCounter.current);
      setMessages((prev) => [
        ...prev,
        {
          id,
          type: 'assistant',
          content: '',
          isStreaming: true,
          streamingContent: '',
          streamingReasoning: '',
        },
      ]);
      return id;
    },

    appendStreamingText: (messageId: string, chunk: string, type: 'reasoning' | 'content') => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m;
          if (type === 'reasoning') {
            return { ...m, streamingReasoning: (m.streamingReasoning || '') + chunk };
          }
          return { ...m, streamingContent: (m.streamingContent || '') + chunk };
        }),
      );
    },

    finalizeAssistantMessage: (messageId: string, fullText: string, fullReasoning: string) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m;
          return {
            ...m,
            isStreaming: false,
            content: fullText,
            reasoning: fullReasoning,
            contentHtml: renderMarkdown(fullText),
            reasoningHtml: renderMarkdown(fullReasoning),
            streamingContent: undefined,
            streamingReasoning: undefined,
          };
        }),
      );
    },

    appendActionMessage: (action: Record<string, unknown> | null, observation: string | ImageObservation) => {
      const id = 'msg-' + (++idCounter.current);
      let obsText: string;
      if (typeof observation === 'object' && observation !== null && observation.type === 'image') {
        obsText = 'Observation: [截图已获取]';
      } else {
        obsText = typeof observation === 'string' ? observation : JSON.stringify(observation);
      }
      setMessages((prev) => [
        ...prev,
        { id, type: 'action', content: '', action, observation: obsText },
      ]);
    },

    setLoading: (loading: boolean) => {
      setIsLoading(loading);
    },

    appendUserMessage: (text: string) => {
      const id = 'msg-' + (++idCounter.current);
      setMessages((prev) => [...prev, { id, type: 'user', content: text }]);
    },

    clearMessages: () => {
      setMessages([]);
    },
  }));

  const isComposingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = () => {
    const text = inputText.trim();
    if (!text) return;
    setInputText('');
    // Reset textarea height after sending
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    onSubmit(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Don't send while IME is composing
    if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault();
      handleSubmit();
    }
    // Shift+Enter inserts a newline (default textarea behavior)
  };

  // Auto-resize textarea to fit content
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  };

  return (
    <div className="chat-panel-container">
      <SettingsPanel onConfigChange={onConfigChange} />

      <div className="chat-message-list" ref={messageListRef}>
        {messages.length === 0 && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: '12px',
            opacity: 0.3,
          }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              letterSpacing: '1px',
              textTransform: 'uppercase' as const,
            }}>
              输入指令开始操控
            </span>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}
      </div>

      <div className="chat-input-area">
        <textarea
          ref={textareaRef}
          className="chat-input"
          placeholder="输入指令... (Shift+Enter 换行)"
          value={inputText}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { isComposingRef.current = true; }}
          onCompositionEnd={() => { isComposingRef.current = false; }}
          disabled={isLoading}
          rows={1}
        />
        <button className="chat-submit-btn" onClick={handleSubmit} disabled={isLoading}>
          发送
        </button>
        <span className={`chat-loading${isLoading ? '' : ' hidden'}`}>处理中...</span>
      </div>
    </div>
  );
});

export default ChatPanel;
