/**
 * VideoPlayer - 基于 Media Source Extensions (MSE) 的视频播放器
 *
 * 负责接收 fMP4 segments 并通过 MSE SourceBuffer 解码播放 H.264 视频流。
 * 实现低延迟策略和缓冲区清理。
 */
export class VideoPlayer {
  private video: HTMLVideoElement;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];
  private isAppending = false;
  private initialized = false;
  private hasInitSegment = false;
  private latencyInterval: ReturnType<typeof setInterval> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  private readonly mimeType = 'video/mp4; codecs="avc1.640029"';
  private readonly latencyCheckInterval = 200;
  private readonly cleanupCheckInterval = 3000;
  private readonly maxBufferDuration = 5;
  private readonly latencyThreshold = 0.2;

  constructor(videoElement: HTMLVideoElement) {
    this.video = videoElement;
  }

  init(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof MediaSource === 'undefined') {
        reject(new Error('MediaSource API is not supported in this browser'));
        return;
      }

      this.mediaSource = new MediaSource();
      this.video.src = URL.createObjectURL(this.mediaSource);

      this.mediaSource.addEventListener('sourceopen', () => {
        try {
          this.sourceBuffer = this.mediaSource!.addSourceBuffer(this.mimeType);
          this.sourceBuffer.mode = 'segments';

          this.sourceBuffer.addEventListener('updateend', () => {
            this.isAppending = false;
            this._processQueue();
          });

          this.sourceBuffer.addEventListener('error', (e) => {
            console.error('[VideoPlayer] SourceBuffer error:', e);
          });

          this.initialized = true;
          this._startLatencyCheck();
          this._startCleanupCheck();
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      this.mediaSource.addEventListener('sourceclose', () => {
        console.log('[VideoPlayer] MediaSource closed');
        this._stopIntervals();
      });

      this.mediaSource.addEventListener('sourceended', () => {
        console.log('[VideoPlayer] MediaSource ended');
      });
    });
  }

  appendData(arrayBuffer: ArrayBuffer): void {
    if (!this.initialized || !this.sourceBuffer) {
      console.warn('[VideoPlayer] Not initialized, dropping data');
      return;
    }

    if (this._isInitSegment(arrayBuffer)) {
      this.onInitSegment(arrayBuffer);
    } else {
      this.onMediaSegment(arrayBuffer);
    }
  }

  onInitSegment(data: ArrayBuffer): void {
    if (!this.initialized || !this.sourceBuffer) {
      console.warn('[VideoPlayer] Not initialized, cannot append init segment');
      return;
    }

    console.log('[VideoPlayer] Init segment received (' + data.byteLength + ' bytes)');

    if (this.hasInitSegment) {
      console.log('[VideoPlayer] Rebuilding MediaSource for new stream');
      this._rebuild(data);
      return;
    }

    this.queue = [];
    this.hasInitSegment = true;
    this._enqueue(data);
  }

  private _rebuild(initData: ArrayBuffer): void {
    this._stopIntervals();
    const video = this.video;

    try {
      if (this.sourceBuffer && this.sourceBuffer.updating) {
        this.sourceBuffer.abort();
      }
      if (this.mediaSource && this.mediaSource.readyState === 'open') {
        this.mediaSource.endOfStream();
      }
    } catch { /* ignore */ }

    if (video.src) {
      URL.revokeObjectURL(video.src);
    }

    this.sourceBuffer = null;
    this.mediaSource = null;
    this.queue = [];
    this.isAppending = false;
    this.hasInitSegment = false;

    this.mediaSource = new MediaSource();
    video.src = URL.createObjectURL(this.mediaSource);

    this.mediaSource.addEventListener('sourceopen', () => {
      try {
        this.sourceBuffer = this.mediaSource!.addSourceBuffer(this.mimeType);
        this.sourceBuffer.mode = 'segments';
        this.sourceBuffer.addEventListener('updateend', () => {
          this.isAppending = false;
          this._processQueue();
        });
        this.sourceBuffer.addEventListener('error', (e) => {
          console.error('[VideoPlayer] SourceBuffer error:', e);
        });

        this.initialized = true;
        this.hasInitSegment = true;
        this._startLatencyCheck();
        this._startCleanupCheck();

        this._enqueue(initData);
        console.log('[VideoPlayer] MediaSource rebuilt, init segment queued');
      } catch (e) {
        console.error('[VideoPlayer] Rebuild error:', e);
      }
    });
  }

  onMediaSegment(data: ArrayBuffer): void {
    if (!this.initialized || !this.sourceBuffer) {
      console.warn('[VideoPlayer] Not initialized, cannot append media segment');
      return;
    }

    if (!this.hasInitSegment) {
      console.warn('[VideoPlayer] No init segment yet, dropping media segment');
      return;
    }

    this._enqueue(data);
  }

  destroy(): void {
    this._stopIntervals();

    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try {
        if (this.sourceBuffer) {
          this.mediaSource.removeSourceBuffer(this.sourceBuffer);
        }
        this.mediaSource.endOfStream();
      } catch { /* ignore */ }
    }

    if (this.video.src) {
      URL.revokeObjectURL(this.video.src);
      this.video.src = '';
    }

    this.sourceBuffer = null;
    this.mediaSource = null;
    this.queue = [];
    this.isAppending = false;
    this.initialized = false;
    this.hasInitSegment = false;
  }

  private _isInitSegment(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 8) return false;
    const view = new DataView(buffer);
    const boxType = view.getUint32(4);
    return boxType === 0x66747970;
  }

  private _enqueue(data: ArrayBuffer): void {
    this.queue.push(data);
    this._processQueue();
  }

  private _processQueue(): void {
    if (this.isAppending || this.queue.length === 0) return;
    if (!this.sourceBuffer || this.mediaSource?.readyState !== 'open') return;

    this.isAppending = true;
    const data = this.queue.shift()!;

    try {
      this.sourceBuffer.appendBuffer(data);
    } catch (e: unknown) {
      console.error('[VideoPlayer] appendBuffer error:', e);
      this.isAppending = false;

      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        this._cleanupBuffer(true);
        this.queue.unshift(data);
      }
    }
  }

  private _startLatencyCheck(): void {
    this.latencyInterval = setInterval(() => {
      this._jumpToLive();
    }, this.latencyCheckInterval);
  }

  private _startCleanupCheck(): void {
    this.cleanupInterval = setInterval(() => {
      this._cleanupBuffer(false);
    }, this.cleanupCheckInterval);
  }

  private _stopIntervals(): void {
    if (this.latencyInterval) {
      clearInterval(this.latencyInterval);
      this.latencyInterval = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private _jumpToLive(): void {
    if (!this.video || !this.video.buffered || this.video.buffered.length === 0) return;

    const bufferedEnd = this.video.buffered.end(this.video.buffered.length - 1);
    const currentTime = this.video.currentTime;
    const lag = bufferedEnd - currentTime;

    if (lag > this.latencyThreshold) {
      this.video.currentTime = bufferedEnd;
    }
  }

  private _cleanupBuffer(force: boolean): void {
    if (!this.sourceBuffer || this.sourceBuffer.updating) return;
    if (!this.video.buffered || this.video.buffered.length === 0) return;

    const bufferedStart = this.video.buffered.start(0);
    const bufferedEnd = this.video.buffered.end(this.video.buffered.length - 1);
    const bufferedDuration = bufferedEnd - bufferedStart;

    if (force || bufferedDuration > this.maxBufferDuration) {
      const removeEnd = bufferedEnd - (force ? 2 : this.maxBufferDuration / 2);
      if (removeEnd > bufferedStart) {
        try {
          this.sourceBuffer.remove(bufferedStart, removeEnd);
        } catch (e) {
          console.error('[VideoPlayer] Buffer cleanup error:', e);
        }
      }
    }
  }
}
