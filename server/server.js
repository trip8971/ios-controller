const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const sharp = require('sharp');
const SessionManager = require('./SessionManager');
const MessageRouter = require('./MessageRouter');

const PORT = process.env.PORT || 8080;
const AGENT_URL = process.env.AGENT_URL || 'http://localhost:8200';

// ============================================================
// HTTP Request Handling — CORS, routing, JSON body parsing
// ============================================================

/**
 * Collect and parse JSON body from an incoming request.
 * Resolves with the parsed object, or rejects on invalid JSON.
 */
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Set CORS headers on every response.
 */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * Send a JSON response helper.
 */
function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Resolve LLM configuration with priority: request body config > env vars > defaults.
 */
function resolveLLMConfig(bodyConfig) {
  const config = bodyConfig || {};
  return {
    baseURL: config.baseURL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    apiKey: config.apiKey || process.env.LLM_API_KEY || '',
    model: config.model || process.env.LLM_MODEL || 'gpt-4o',
  };
}

/**
 * POST /api/llm/chat — proxy requests to an OpenAI-compatible LLM API.
 * Supports both streaming (SSE) and non-streaming modes.
 */
function handleLLMChat(req, res) {
  const { messages, stream, config, tools, tool_choice } = req.body;
  const llmConfig = resolveLLMConfig(config);

  // Build the LLM API URL
  const baseURL = llmConfig.baseURL.replace(/\/+$/, '');
  const targetUrl = new URL(`${baseURL}/chat/completions`);

  // Build the request payload
  const payloadObj = {
    model: llmConfig.model,
    messages,
    stream: !!stream,
  };
  // Forward tools/tool_choice if provided
  if (tools) payloadObj.tools = tools;
  if (tool_choice) payloadObj.tool_choice = tool_choice;

  const payload = JSON.stringify(payloadObj);

  // Choose http or https based on protocol
  const transport = targetUrl.protocol === 'https:' ? https : http;

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: 30000,
  };

  if (llmConfig.apiKey) {
    options.headers['Authorization'] = `Bearer ${llmConfig.apiKey}`;
  }

  const proxyReq = transport.request(options, (proxyRes) => {
    const statusCode = proxyRes.statusCode;

    // LLM API returned an error status code
    if (statusCode >= 400) {
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        let errorBody;
        try {
          errorBody = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          errorBody = { message: Buffer.concat(chunks).toString() || 'LLM API error' };
        }
        sendJson(res, statusCode, { error: errorBody });
      });
      return;
    }

    if (stream) {
      // Streaming mode: forward SSE data chunks
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      proxyRes.on('data', (chunk) => {
        res.write(chunk);
      });
      proxyRes.on('end', () => {
        res.end();
      });
      proxyRes.on('error', () => {
        res.end();
      });
    } else {
      // Non-streaming mode: collect full response and return as JSON
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      });
      proxyRes.on('error', () => {
        sendJson(res, 502, { error: 'Error reading LLM API response' });
      });
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    sendJson(res, 504, { error: 'LLM API request timeout' });
  });

  proxyReq.on('error', (err) => {
    if (res.headersSent) return;
    sendJson(res, 502, { error: `LLM API connection failed: ${err.message}` });
  });

  proxyReq.write(payload);
  proxyReq.end();
}

/**
 * GET /api/screenshot — proxy screenshot request to the device Agent.
 * Sends POST /screenshot to AGENT_URL, receives raw PNG binary data,
 * converts to base64, and returns JSON response.
 */
function handleScreenshot(req, res) {
  const url = new URL('/screenshot', AGENT_URL);
  const payload = JSON.stringify({});

  const agentReq = http.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: 10000,
  }, (agentRes) => {
    const statusCode = agentRes.statusCode;

    if (statusCode !== 200) {
      // Agent returned an error — collect the response and return 502
      const chunks = [];
      agentRes.on('data', (chunk) => chunks.push(chunk));
      agentRes.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let errorMessage;
        try {
          const parsed = JSON.parse(raw);
          errorMessage = parsed.error || raw;
        } catch {
          errorMessage = raw || 'Agent error';
        }
        sendJson(res, 502, { success: false, error: errorMessage });
      });
      return;
    }

    // Success — collect PNG binary data, compress to JPEG, return as base64
    const chunks = [];
    agentRes.on('data', (chunk) => chunks.push(chunk));
    agentRes.on('end', async () => {
      try {
        const pngBuffer = Buffer.concat(chunks);
        const jpegBuffer = await sharp(pngBuffer)
          .resize({ width: 1024, withoutEnlargement: true })
          .jpeg({ quality: 60 })
          .toBuffer();
        const base64 = jpegBuffer.toString('base64');
        sendJson(res, 200, { success: true, image: base64, format: 'jpeg' });
      } catch (err) {
        // Fallback: return original PNG if compression fails
        const base64 = Buffer.concat(chunks).toString('base64');
        sendJson(res, 200, { success: true, image: base64, format: 'png' });
      }
    });
  });

  agentReq.on('timeout', () => {
    agentReq.destroy();
    sendJson(res, 504, { success: false, error: 'screenshot timeout' });
  });

  agentReq.on('error', (err) => {
    if (res.headersSent) return;
    sendJson(res, 502, { success: false, error: err.message });
  });

  agentReq.write(payload);
  agentReq.end();
}

/**
 * Main HTTP request handler.
 * Sets CORS headers, handles OPTIONS preflight, routes to API handlers,
 * and returns 404 for unknown paths.
 */
async function handleHttpRequest(req, res) {
  setCorsHeaders(res);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const { url, method } = req;

  // Route: POST /api/llm/chat
  if (method === 'POST' && url === '/api/llm/chat') {
    try {
      req.body = await parseJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON in request body' });
      return;
    }
    handleLLMChat(req, res);
    return;
  }

  // Route: GET /api/screenshot
  if (method === 'GET' && url === '/api/screenshot') {
    handleScreenshot(req, res);
    return;
  }

  // Unknown path → 404
  sendJson(res, 404, { error: 'Not found' });
}

// ============================================================
// Server Initialization
// ============================================================

const httpServer = http.createServer(handleHttpRequest);
const wss = new WebSocket.Server({ server: httpServer });
const sessionManager = new SessionManager();
const messageRouter = new MessageRouter();

// ============================================================
// XCUITest Agent — 通过 HTTP 转发控制指令到设备
// ============================================================

function forwardToAgent(cmd, viewerWs) {
  let path;
  let body;

  switch (cmd.type) {
    case 'tap':
      path = '/tap';
      body = { x: cmd.x, y: cmd.y };
      break;
    case 'swipe':
      path = '/swipe';
      body = { startX: cmd.startX, startY: cmd.startY, endX: cmd.endX, endY: cmd.endY };
      break;
    case 'volume_up':
      path = '/pressButton';
      body = { name: 'volumeUp' };
      break;
    case 'volume_down':
      path = '/pressButton';
      body = { name: 'volumeDown' };
      break;
    case 'home':
      path = '/pressButton';
      body = { name: 'home' };
      break;
    case 'screenshot':
      path = '/screenshot';
      body = {};
      break;
    case 'input':
      path = '/input';
      body = { text: cmd.text, clearText: cmd.clearText || false };
      break;
    default:
      return;
  }

  // Try XCUITest HTTP agent first, fall back to simctl for Simulator
  console.log(`[Agent] Forwarding ${cmd.type} to ${AGENT_URL}${path}`);
  const data = JSON.stringify(body);
  const url = new URL(path, AGENT_URL);

  const req = http.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    timeout: 5000,
  }, (res) => {
    let chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const resp = Buffer.concat(chunks).toString();
      console.log(`[Agent] ${cmd.type} → ${res.statusCode} ${resp}`);
      if (cmd.cmdId !== undefined && viewerWs && viewerWs.readyState === WebSocket.OPEN) {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        let error = null;
        if (!ok) {
          try { error = JSON.parse(resp).error || resp; } catch { error = resp || `HTTP ${res.statusCode}`; }
        }
        viewerWs.send(JSON.stringify({ type: 'cmd_result', cmdId: cmd.cmdId, ok, error }));
      }
    });
  });

  req.on('error', (err) => {
    console.error(`[Agent] ${cmd.type} failed: ${err.message} (is XCUITest running? iproxy 8200 8200?)`);
    if (cmd.cmdId !== undefined && viewerWs && viewerWs.readyState === WebSocket.OPEN) {
      viewerWs.send(JSON.stringify({ type: 'cmd_result', cmdId: cmd.cmdId, ok: false, error: err.message }));
    }
  });

  req.on('timeout', () => {
    console.error(`[Agent] ${cmd.type} timed out`);
    req.destroy();
    if (cmd.cmdId !== undefined && viewerWs && viewerWs.readyState === WebSocket.OPEN) {
      viewerWs.send(JSON.stringify({ type: 'cmd_result', cmdId: cmd.cmdId, ok: false, error: 'timeout' }));
    }
  });

  req.write(data);
  req.end();
}

// ============================================================
// WebSocket Server
// ============================================================

httpServer.on('listening', () => {
  console.log(`[Server] HTTP + WebSocket on port ${PORT}`);
  console.log(`[Server] XCUITest agent: ${AGENT_URL}`);
});

wss.on('connection', (ws) => {
  ws.on('message', (data, isBinary) => {
    const role = sessionManager.getRoleByWs(ws) || 'unregistered';
    const session = sessionManager.getSessionByWs(ws);

    if (session) {
      // Viewer JSON → forward to agent + route normally
      if (role === 'viewer' && !isBinary) {
        try {
          const cmd = JSON.parse(data.toString());
          console.log(`[Server] Viewer command: ${cmd.type}`);
          forwardToAgent(cmd, ws);
        } catch {}
      }
      messageRouter.route(ws, data, role, session);
      return;
    }

    if (isBinary) {
      if (role === 'device') {
        if (!ws._pendingBinaryData) ws._pendingBinaryData = [];
        ws._pendingBinaryData.push(data);
      }
      return;
    }

    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'register' && message.role) {
        const result = sessionManager.registerConnection(ws, message.role);

        if (result && result.error === 'invalid_role') {
          ws.close(1008, 'Invalid role');
          return;
        }

        if (message.role === 'device' && message.deviceInfo) {
          sessionManager.setDeviceInfo(ws, message.deviceInfo);
        }

        if (result && result.sessionId) {
          console.log(`[Server] Session ${result.sessionId} active (${result.viewers.length} viewers)`);

          if (result.device && result.device._deviceInfo) {
            result.deviceInfo = result.device._deviceInfo;
          }

          const sessionReadyMsg = JSON.stringify({
            type: 'session_ready',
            sessionId: result.sessionId,
            deviceInfo: result.deviceInfo || null,
          });

          if (result.device && result.device.readyState === WebSocket.OPEN) {
            result.device.send(sessionReadyMsg);
          }
          for (const viewer of result.viewers) {
            if (viewer && viewer.readyState === WebSocket.OPEN) {
              viewer.send(sessionReadyMsg);
              messageRouter.replayInitSegment(result.sessionId, viewer);
            }
          }

          // Ask device to force a keyframe so new viewer gets immediate picture
          if (result.device && result.device.readyState === WebSocket.OPEN) {
            result.device.send(JSON.stringify({ type: 'request_keyframe' }));
          }
          if (result.controller && result.controller.readyState === WebSocket.OPEN) {
            result.controller.send(sessionReadyMsg);
          }

          if (result.device && result.device._pendingBinaryData) {
            for (const pendingData of result.device._pendingBinaryData) {
              messageRouter.route(result.device, pendingData, 'device', result);
            }
            result.device._pendingBinaryData = null;
          }
        }
      } else {
        ws.close(1008, 'Invalid registration message');
      }
    } catch {
      ws.close(1008, 'Invalid message format');
    }
  });

  ws.on('close', (code) => {
    const role = sessionManager.getRoleByWs(ws);
    const session = sessionManager.handleDisconnect(ws);

    if (session && role === 'device') {
      messageRouter.clearInitSegmentCache(session.sessionId);
      const msg = JSON.stringify({ type: 'session_ended', reason: 'device_disconnected' });
      for (const viewer of (session.viewers || [])) {
        if (viewer && viewer.readyState === WebSocket.OPEN) viewer.send(msg);
      }
      if (session.controller && session.controller.readyState === WebSocket.OPEN) {
        session.controller.send(msg);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[Server] WebSocket error:', err.message);
  });
});

wss.on('error', (err) => {
  console.error(`[Server] WebSocket error: ${err.message}`);
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] Port ${PORT} already in use`);
    process.exit(1);
  }
});

httpServer.listen(PORT);

module.exports = { httpServer, wss, sessionManager, messageRouter, handleHttpRequest, parseJsonBody, resolveLLMConfig, handleLLMChat, handleScreenshot };
