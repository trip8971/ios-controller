import type { ConnectionStatus as Status } from '../services/RemoteControlClient';

interface ConnectionStatusProps {
  status: Status;
  retryCount: number;
  maxRetries: number;
}

const statusTextMap: Record<Status, string> = {
  connected: '已连接',
  connecting: '连接中...',
  disconnected: '已断开',
};

export default function ConnectionStatus({ status, retryCount, maxRetries }: ConnectionStatusProps) {
  const text =
    status === 'disconnected' && retryCount >= maxRetries
      ? '无法连接服务器'
      : statusTextMap[status];

  return (
    <div className="connection-status" role="status" aria-live="polite">
      <span className={`status-dot ${status}`} />
      <span className="status-text">{text}</span>
    </div>
  );
}
