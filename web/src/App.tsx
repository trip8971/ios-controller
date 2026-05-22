import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import DeviceFrame from './components/DeviceFrame';
import ChatPanel, { ChatPanelHandle } from './components/ChatPanel';
import ConnectionStatus from './components/ConnectionStatus';
import { RemoteControlClient, ConnectionStatus as ConnStatus } from './services/RemoteControlClient';
import { LLMClient, LLMConfig } from './services/LLMClient';
import { ReACTExecutor, ChatCallbacks } from './services/ReACTExecutor';

export default function App() {
  const [connectionStatus, setConnectionStatus] = useState<ConnStatus>('disconnected');
  const [retryCount, setRetryCount] = useState(0);

  const chatPanelRef = useRef<ChatPanelHandle>(null);
  const llmClientRef = useRef<LLMClient>(new LLMClient());
  const executorRef = useRef<ReACTExecutor | null>(null);

  const client = useMemo(() => {
    const c = new RemoteControlClient();
    c.onStatusChange = (status) => {
      setConnectionStatus(status);
      setRetryCount(c.retryCount);
    };
    return c;
  }, []);

  useEffect(() => {
    const wsUrl = client.serverUrl;
    llmClientRef.current.apiBase = wsUrl.replace(/^ws/, 'http').replace(/\/$/, '');
  }, [client]);

  useEffect(() => {
    const callbacks: ChatCallbacks = {
      createAssistantMessage: () => chatPanelRef.current?.createAssistantMessage() || '',
      appendStreamingText: (id, chunk, type) => chatPanelRef.current?.appendStreamingText(id, chunk, type),
      finalizeAssistantMessage: (id, text, reasoning) =>
        chatPanelRef.current?.finalizeAssistantMessage(id, text, reasoning),
      appendActionMessage: (action, obs) => chatPanelRef.current?.appendActionMessage(action, obs),
      setLoading: (loading) => chatPanelRef.current?.setLoading(loading),
    };

    executorRef.current = new ReACTExecutor(llmClientRef.current, callbacks, client);
  }, [client]);

  const handleChatSubmit = useCallback((text: string) => {
    chatPanelRef.current?.appendUserMessage(text);
    executorRef.current?.handleUserMessage(text);
  }, []);

  const handleConfigChange = useCallback((config: LLMConfig) => {
    llmClientRef.current.updateConfig(config);
  }, []);

  const handleClearChat = useCallback(() => {
    llmClientRef.current.clearHistory();
    chatPanelRef.current?.clearMessages();
  }, []);

  return (
    <div className="page-container">
      <DeviceFrame client={client} connectionStatus={connectionStatus} />

      <div style={{ position: 'relative' }}>
        <ChatPanel
          ref={chatPanelRef}
          onSubmit={handleChatSubmit}
          onConfigChange={handleConfigChange}
        />
        <button className="clear-chat-btn" onClick={handleClearChat}>
          清除对话
        </button>
      </div>

      <ConnectionStatus
        status={connectionStatus}
        retryCount={retryCount}
        maxRetries={client.maxRetries}
      />
    </div>
  );
}
