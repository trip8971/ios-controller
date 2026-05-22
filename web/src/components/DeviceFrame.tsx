import { useRef, useEffect, useCallback } from 'react';
import { RemoteControlClient, ConnectionStatus } from '../services/RemoteControlClient';
import { VideoPlayer } from '../services/VideoPlayer';
import { InteractionHandler } from '../services/InteractionHandler';

interface DeviceFrameProps {
  client: RemoteControlClient;
  connectionStatus: ConnectionStatus;
}

export default function DeviceFrame({ client, connectionStatus }: DeviceFrameProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const videoPlayerRef = useRef<VideoPlayer | null>(null);
  const interactionRef = useRef<InteractionHandler | null>(null);
  const showVideo = useRef(false);

  const handleVideoReceived = useCallback(() => {
    showVideo.current = true;
    const overlay = document.getElementById('waitingOverlay');
    if (overlay) overlay.classList.add('hidden');
  }, []);

  useEffect(() => {
    if (!videoRef.current || !screenRef.current) return;

    const vp = new VideoPlayer(videoRef.current);
    videoPlayerRef.current = vp;
    client.setVideoPlayer(vp);
    client.onVideoReceived = handleVideoReceived;

    vp.init().then(() => {
      console.log('[DeviceFrame] VideoPlayer initialized');
      client.connect();
    }).catch((err) => {
      console.error('[DeviceFrame] VideoPlayer init failed:', err);
      client.connect();
    });

    const deviceResolution = { width: 393, height: 852 };
    const handler = new InteractionHandler(screenRef.current, client, deviceResolution);
    interactionRef.current = handler;

    return () => {
      handler.destroy();
      vp.destroy();
    };
  }, [client, handleVideoReceived]);

  const showWaiting = connectionStatus !== 'connected' || !showVideo.current;
  const showReconnect = connectionStatus === 'disconnected' && client.retryCount >= client.maxRetries;

  const handleVolumeUp = () => client.sendCommand({ type: 'volume_up' });
  const handleVolumeDown = () => client.sendCommand({ type: 'volume_down' });
  const handleHome = () => client.sendCommand({ type: 'home' });

  const handleScreenshot = async () => {
    try {
      const resp = await fetch('http://localhost:8200/screenshot');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } catch (err) {
      alert('截图失败: ' + (err as Error).message);
    }
  };

  const handleInput = () => {
    const text = prompt('输入要发送的文本:');
    if (text) {
      client.sendCommand({ type: 'input', text });
    }
  };

  const handleReconnect = () => {
    client.manualReconnect();
  };

  return (
    <div className="device-wrapper">
      {/* 侧边工具栏 */}
      <div className="toolbar-buttons">
        <button className="toolbar-btn" onClick={handleVolumeUp} aria-label="音量增加" title="音量+">+</button>
        <button className="toolbar-btn" onClick={handleVolumeDown} aria-label="音量减少" title="音量-">−</button>
        <button className="toolbar-btn" onClick={handleHome} aria-label="Home" title="Home">⌂</button>
        <button className="toolbar-btn" onClick={handleScreenshot} aria-label="截图" title="截图">📷</button>
        <button className="toolbar-btn" onClick={handleInput} aria-label="输入" title="文本输入">⌨</button>
      </div>

      {/* 视频画面（无边框） */}
      <div className="video-container" ref={screenRef}>
        <video ref={videoRef} autoPlay muted playsInline />

        <div className={`waiting-overlay${showWaiting && !showReconnect ? '' : ' hidden'}`} id="waitingOverlay">
          <span className="waiting-text">等待连接...</span>
        </div>

        <div className={`reconnect-overlay${showReconnect ? '' : ' hidden'}`}>
          <span className="reconnect-text">连接已断开</span>
          <button className="reconnect-btn" onClick={handleReconnect} aria-label="手动重连">重新连接</button>
        </div>
      </div>
    </div>
  );
}
