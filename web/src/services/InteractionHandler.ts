import { RemoteControlClient } from './RemoteControlClient';

/**
 * CoordinateMapper - Web 坐标到设备坐标的映射
 */
export class CoordinateMapper {
  constructor(
    public displayWidth: number,
    public displayHeight: number,
    public deviceWidth: number,
    public deviceHeight: number,
  ) {}

  mapToDevice(clientX: number, clientY: number): { x: number; y: number } {
    const x = clientX * (this.deviceWidth / this.displayWidth);
    const y = clientY * (this.deviceHeight / this.displayHeight);
    return { x, y };
  }
}

/**
 * InteractionHandler - 交互捕获与控制指令生成
 *
 * 监听设备屏幕元素上的鼠标事件，区分 tap 和 swipe，
 * 使用归一化坐标通过 RemoteControlClient 发送 Control_Command。
 */
export class InteractionHandler {
  private screenElement: HTMLElement;
  private client: RemoteControlClient;
  private deviceWidth: number;
  private deviceHeight: number;

  private readonly moveThreshold = 5;
  private readonly minSwipeDuration = 0.1;

  private _isPressed = false;
  private _startX = 0;
  private _startY = 0;
  private _currentX = 0;
  private _currentY = 0;
  private _startTime = 0;

  private _onMouseDown: (e: MouseEvent) => void;
  private _onMouseMove: (e: MouseEvent) => void;
  private _onMouseUp: (e: MouseEvent) => void;
  private _onContextMenu: (e: MouseEvent) => void;

  constructor(
    screenElement: HTMLElement,
    client: RemoteControlClient,
    deviceResolution: { width: number; height: number },
  ) {
    this.screenElement = screenElement;
    this.client = client;
    this.deviceWidth = deviceResolution.width;
    this.deviceHeight = deviceResolution.height;

    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onContextMenu = this._handleContextMenu.bind(this);

    this._bindEvents();
  }

  private _bindEvents(): void {
    this.screenElement.addEventListener('mousedown', this._onMouseDown);
    this.screenElement.addEventListener('mousemove', this._onMouseMove);
    this.screenElement.addEventListener('mouseup', this._onMouseUp);
    this.screenElement.addEventListener('contextmenu', this._onContextMenu);
    document.addEventListener('mouseup', this._onMouseUp);
  }

  destroy(): void {
    this.screenElement.removeEventListener('mousedown', this._onMouseDown);
    this.screenElement.removeEventListener('mousemove', this._onMouseMove);
    this.screenElement.removeEventListener('mouseup', this._onMouseUp);
    this.screenElement.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('mouseup', this._onMouseUp);
  }

  private _getNormalizedPosition(event: MouseEvent): { x: number; y: number } | null {
    const video = this.screenElement.querySelector('video');
    const rect = this.screenElement.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;

    if (!video || !video.videoWidth || !video.videoHeight) {
      return { x: clickX / rect.width, y: clickY / rect.height };
    }

    const videoAspect = video.videoWidth / video.videoHeight;
    const containerAspect = rect.width / rect.height;

    let renderWidth: number, renderHeight: number, offsetX: number, offsetY: number;

    if (videoAspect > containerAspect) {
      renderWidth = rect.width;
      renderHeight = rect.width / videoAspect;
      offsetX = 0;
      offsetY = (rect.height - renderHeight) / 2;
    } else {
      renderHeight = rect.height;
      renderWidth = rect.height * videoAspect;
      offsetX = (rect.width - renderWidth) / 2;
      offsetY = 0;
    }

    const videoX = clickX - offsetX;
    const videoY = clickY - offsetY;

    if (videoX < 0 || videoX > renderWidth || videoY < 0 || videoY > renderHeight) {
      return null;
    }

    return {
      x: videoX / renderWidth,
      y: videoY / renderHeight,
    };
  }

  private _handleMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();

    const pos = this._getNormalizedPosition(event);
    if (!pos) return;

    this._isPressed = true;
    this._startX = pos.x;
    this._startY = pos.y;
    this._currentX = pos.x;
    this._currentY = pos.y;
    this._startTime = Date.now();
  }

  private _handleMouseMove(event: MouseEvent): void {
    if (!this._isPressed) return;
    const pos = this._getNormalizedPosition(event);
    if (pos) {
      this._currentX = pos.x;
      this._currentY = pos.y;
    }
  }

  private _handleMouseUp(event: MouseEvent): void {
    if (!this._isPressed) return;
    if (event.button !== 0) return;
    this._isPressed = false;

    const endPos = this._getNormalizedPosition(event);
    if (endPos) {
      this._currentX = endPos.x;
      this._currentY = endPos.y;
    }

    const dx = this._currentX - this._startX;
    const dy = this._currentY - this._startY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > 0.02) {
      let duration = (Date.now() - this._startTime) / 1000;
      if (duration < this.minSwipeDuration) duration = this.minSwipeDuration;

      const cmd = {
        type: 'swipe',
        startX: this._startX,
        startY: this._startY,
        endX: this._currentX,
        endY: this._currentY,
        normalized: true,
        duration,
      };
      console.log('[InteractionHandler] Swipe:', cmd);
      this.client.sendCommand(cmd);
    } else {
      const cmd = {
        type: 'tap',
        x: this._startX,
        y: this._startY,
        normalized: true,
      };
      console.log('[InteractionHandler] Tap:', cmd);
      this.client.sendCommand(cmd);
    }
  }

  private _handleContextMenu(event: MouseEvent): void {
    event.preventDefault();
  }
}
