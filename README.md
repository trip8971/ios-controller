# iOS Remote Control

> 浏览器中实时观看与操控 iOS 设备/模拟器，附带 LLM 自然语言控制能力。

类 [appetize.io](https://appetize.io) 的 iOS 远程控制系统：iOS 端通过 ReplayKit 采集屏幕并以 H.264 / fMP4 推流，浏览器通过 MSE 解码播放并捕获用户交互，控制指令经信令服务器转发到 XCUITest Agent 在设备上执行。在此之上，Web 端集成了基于 ReACT + OpenAI Tool Use 的 LLM 对话面板，可以用自然语言指挥手机完成多步操作（截图观察 → 思考 → 调用工具 → 再观察）。

---

## Demo

> 打开携程app预订5月28日北京到上海最便宜的机票

https://github.com/user-attachments/assets/0375c6d6-a58b-423f-9e69-60e7bd523456

---

## 功能特性

- **60fps 低延迟视频流**：ReplayKit Broadcast Upload Extension + VideoToolbox 硬件编码 H.264 → 自定义 fMP4 muxer → WebSocket 二进制帧 → 浏览器 MSE。
- **完整的远程控制**：tap / swipe / volume_up / volume_down / home / screenshot / 文本输入。坐标支持归一化（0–1）以适配任意分辨率。
- **真机 + 模拟器双模**：真机走 ReplayKit + XCUITest（iproxy 转发 8200 端口）；本机模拟器额外提供基于 ScreenCaptureKit 的 Swift 采集进程，免去安装 App。
- **LLM 自然语言操控**：内置 ChatPanel + ReACTExecutor。Function Calling 模式让 LLM 直接发出工具调用，配合 Vision 截图观察实现闭环。SSE 流式响应、reasoning_content 推理过程展示、`<think>` 标签解析、批量 tool_calls。
- **OpenAI 兼容代理**：服务器内置 `/api/llm/chat`（SSE 透传）和 `/api/screenshot`（PNG → JPEG 压缩为 base64）两个端点，避免 CORS 与暴露 API Key。
- **属性测试覆盖**：基于 fast-check 的 property-based tests 覆盖消息转发完整性、坐标映射、ReACT round-trip、SSE chunk 累积、配置优先级等关键不变量（每条属性 ≥100 次随机迭代）。

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          浏览器 (web/)                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────────────┐   │
│  │ DeviceFrame  │  │  ChatPanel   │  │       App.tsx (React)        │   │
│  │  + MSE Video │  │  + Settings  │  │                              │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────────────────────────┘   │
│         │                 │                                             │
│  ┌──────▼─────────────┐  ┌▼───────────────┐  ┌────────────────────┐    │
│  │ RemoteControlClient│  │   LLMClient    │  │   ReACTExecutor    │    │
│  │ WebSocket (二进制) │  │  SSE 流式解析  │  │   工具调用编排     │    │
│  └──────┬─────────────┘  └────────┬───────┘  └─────────┬──────────┘    │
└─────────┼──────────────────────────┼────────────────────┼──────────────┘
          │ ws://:8080               │ POST /api/llm/chat │ GET /api/screenshot
          │  二进制 fMP4 + JSON cmd  │   (SSE)            │
┌─────────▼──────────────────────────▼────────────────────▼──────────────┐
│                  信令服务器 server/ (Node.js + TypeScript)              │
│  ┌────────────────┐  ┌────────────────┐  ┌─────────────────────────┐   │
│  │ SessionManager │  │ MessageRouter  │  │  HTTP API: LLM 代理 +   │   │
│  │ device/viewer/ │  │ 二进制路由     │  │  Screenshot 代理        │   │
│  │ controller 配对│  │ initSegment 缓存│  │  (ws + http 共享端口)   │   │
│  └────────────────┘  └────────────────┘  └─────────────────────────┘   │
└─────────┬──────────────────────────────────────┬───────────────────────┘
          │ 视频帧                                │ HTTP /tap /swipe ...
          │                                       │
┌─────────▼──────────────┐               ┌────────▼─────────────────────┐
│  iOS Device            │               │  XCUITest Agent (端口 8200) │
│  ioscontroller App     │               │  Springboard 上注入触摸 +   │
│  + Broadcast Extension │               │  WDA 风格私有 API 注入键盘  │
│  (H.264 + fMP4 muxer)  │               │  + XCUIScreen.screenshot    │
└────────────────────────┘               └─────────────────────────────┘

或在本机：simulator-capture (Swift + ScreenCaptureKit) 直接抓取 Simulator 窗口
```

### 数据流要点

- **视频流**：`device` 角色的 WebSocket 把 fMP4 init segment 与 media segments 发到 server，server 用 ftyp box magic bytes 识别 init segment 并缓存，转发给 `viewer`；新加入的 viewer 自动重放最近一次 init segment。
- **控制指令**：viewer 发 JSON 命令 → server 直接 HTTP POST 到 `AGENT_URL`（默认 `http://localhost:8200`）→ Agent 在主线程执行 XCUITest 操作 → 通过 `cmd_result` 回包带 `cmdId` 通知 viewer 完成状态。
- **LLM 控制**：LLMClient 用 OpenAI Function Calling 方式调用 server 的 `/api/llm/chat`，server SSE 透传 LLM 响应。模型返回 `tool_calls` 后，ReACTExecutor 依次执行（screenshot 类工具直接走 `/api/screenshot` HTTP 通道，其它工具复用 RemoteControlClient WebSocket），把结果作为 `tool` 角色消息追加到上下文，进入下一轮，直到模型不再调用工具为止。

---

## 项目结构

```
ios-controller/
├── ioscontroller/                    Xcode 项目（Objective-C）
│   ├── ioscontroller/                主 App：UI + RPSystemBroadcastPickerView
│   ├── BroadcastExtension/           ReplayKit 扩展：H.264 编码 + fMP4 封装 + WebSocket
│   ├── BroadcastExtensionSetupUI/    Broadcast 启动 UI
│   └── ioscontrollerUITests/         XCUITest Agent（监听 :8200，HTTP 服务）
│
├── server/                           信令服务器（Node.js + TypeScript）
│   ├── src/
│   │   ├── server.ts                 入口：HTTP + WebSocket，LLM/截图代理
│   │   ├── SessionManager.ts         Session 配对与生命周期
│   │   └── MessageRouter.ts          二进制/JSON 路由 + initSegment 缓存
│   └── __tests__/                    Jest + fast-check 属性测试
│
├── web/                              Web 前端（React 19 + TypeScript + Vite）
│   ├── src/
│   │   ├── App.tsx                   组合根
│   │   ├── components/               DeviceFrame / ChatPanel / ConnectionStatus
│   │   └── services/                 RemoteControlClient / VideoPlayer /
│   │                                 InteractionHandler / LLMClient / ReACTExecutor
│   └── __tests__/                    Vitest + fast-check
│
├── simulator-capture/                Swift CLI（仅 macOS）
│   └── Sources/main.swift            ScreenCaptureKit 抓取 Simulator 窗口
│                                     + VideoToolbox H.264 + 自实现 fMP4 muxer
│
├── .kiro/specs/                      Spec 驱动开发产物
│   ├── ios-remote-control/           核心远程控制需求/设计/任务
│   └── llm-phone-control/            LLM 对话控制需求/设计/任务
│
└── start.sh                          一键启动（自动检测 Simulator）
```

---

## 快速开始

### 前置依赖

- macOS 13+（`simulator-capture` 需要 ScreenCaptureKit）
- Xcode 15+ 和 iOS Simulator（或一台真机 + 开发证书）
- Node.js 18+
- 用真机时需要 `iproxy`（属于 `libimobiledevice`）：`brew install libimobiledevice`

### 安装依赖

```bash
cd server && npm install
cd ../web   && npm install
```

### 一键启动（推荐）

```bash
./start.sh
```

脚本会：
1. 杀掉占用 8080 / 5173 端口的旧进程
2. 启动 server（`npx tsx src/server.ts`，端口 8080）
3. 启动 Vite dev server（端口 5173，开 `--host` 便于真机访问）
4. 检测是否有运行中的 Simulator：有则编译并运行 `simulator-capture` Swift 进程；没有则保持真机模式

打开 http://localhost:5173 即可。`Ctrl+C` 同时关闭三方。

### 真机模式

1. 用 Xcode 打开 `ioscontroller/ioscontroller.xcodeproj`，配置 Team 与 App Group `group.com.yourappleid.ioscontroller`，运行到设备。
2. 在真机 App 输入信令服务器地址（如 `ws://你电脑的局域网IP:8080`），保存。
3. 在 Mac 上转发 XCUITest Agent 端口：

   ```bash
   iproxy 8200 8200
   ```

4. 在 Xcode 中 `Product → Test`，选择 `ioscontrollerUITests / ControlAgentTests / testControlAgent`，让它一直运行（这就是 Agent 进程）。
5. 在 App 内点红色录制按钮启动 Broadcast Extension，浏览器即可看到画面。

### LLM 配置

在 ChatPanel 顶部的 `⚙ 设置` 里填入：

| 字段 | 说明 | 默认 |
|------|------|------|
| Base URL | OpenAI 兼容端点 | `https://api.openai.com/v1` |
| API Key | 鉴权密钥 | 空 |
| 模型名称 | 任何支持 tool use + vision 的模型 | `gpt-4o` |

或者通过环境变量启动 server（请求体中的 `config` 优先级更高）：

```bash
LLM_BASE_URL=https://api.openai.com/v1 \
LLM_API_KEY=sk-... \
LLM_MODEL=gpt-4o \
npx tsx server/src/server.ts
```

---

## 开发

### 服务器

```bash
cd server
npm run dev      # tsx watch
npm test         # Jest（含 property tests）
npm run build    # tsc → dist/
```

### Web

```bash
cd web
npm run dev      # Vite，代理 /api → :8080
npm run build    # tsc -b && vite build
npm test         # vitest run
```

### iOS

直接用 Xcode。三个 Target：

- `ioscontroller`：主 App
- `BroadcastExtension`：录屏扩展
- `BroadcastExtensionSetupUI`：录屏启动器
- `ioscontrollerUITests`：XCUITest Agent（Test 而非 Run）

### Swift 模拟器抓帧

```bash
cd simulator-capture
swift build
swift run -- ws://localhost:8080
```

---

## 关键技术细节

- **fMP4 muxer 是手写的**（Objective-C 与 Swift 各一份），输出 `ftyp` + `moov` 作为 init segment，`moof + mdat` 作为 media segment。`avcC` box 中嵌入 SPS/PPS，`trun` 中带 `data_offset` 与 sample flags（关键帧 = `0x02000000`，非关键帧 = `0x01010000`）。
- **MSE 低延迟策略**：每 200ms 检查一次 `video.buffered`，落后于 live edge 0.2s 就 seek 到末尾；每 3s 清理 5s 之前的旧 buffer；遇 `QuotaExceededError` 强制清空。
- **XCUITest 文本输入**：使用 WDA 同款的 `XCSynthesizedEventRecord` + `XCPointerEventPath` 私有 API 直接向系统注入按键事件，绕开 `hasKeyboardFocus` 检查，原生输入框 / WebView 通用。清空走 `0x7F` 字符或 Cmd+A + Backspace。
- **触摸目标使用 Springboard**：Agent 不启动被测应用，直接以 `com.apple.springboard` 为触摸坐标系，所以坐标是相对整个屏幕的。
- **forceKeyframe 机制**：viewer 一加入，server 给 device 发 `request_keyframe`；device 端编码器在下一帧设置 `kVTEncodeFrameOptionKey_ForceKeyFrame`，新 viewer 几乎立刻能起播。
- **截图压缩**：server 收到 PNG 后用 sharp 缩到宽度 1024 并转 JPEG q=60，避免把几 MB 的原图喂给 LLM。
- **LLM `<think>` 标签**：流式解析时实时把 `<think>...</think>` 中的内容路由到 reasoning 通道，外层文字走 content 通道，UI 用可折叠的"思考过程"块展示。

---

## Spec 驱动

完整的需求 / 设计 / 任务文档在 `.kiro/specs/` 下：

- `ios-remote-control/`：基础视频流与控制（10 项需求 + 8 条正确性属性）
- `llm-phone-control/`：LLM 对话控制扩展（10 项需求 + 16 条正确性属性）

每条 fast-check 属性测试都引用对应属性编号（如 `Feature: ios-remote-control, Property 1: 二进制数据转发完整性`），方便从规格 → 测试反向追溯。
