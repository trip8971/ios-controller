/**
 * @jest-environment jsdom
 */

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

const LLMClient = require('../LLMClient');

function createMockReadableStream(chunks) {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    getReader() {
      return {
        async read() {
          if (index < chunks.length) {
            const value = encoder.encode(chunks[index]);
            index++;
            return { done: false, value };
          }
          return { done: true, value: undefined };
        }
      };
    }
  };
}

describe('LLMClient.parseSSELine', () => {
  test('returns done:true for [DONE]', () => {
    const result = LLMClient.parseSSELine('data: [DONE]');
    expect(result.done).toBe(true);
  });

  test('extracts delta.content', () => {
    const json = JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] });
    const result = LLMClient.parseSSELine(`data: ${json}`);
    expect(result.content).toBe('Hello');
    expect(result.reasoning).toBeNull();
    expect(result.toolCalls).toBeNull();
  });

  test('extracts delta.reasoning_content', () => {
    const json = JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] });
    const result = LLMClient.parseSSELine(`data: ${json}`);
    expect(result.reasoning).toBe('thinking');
    expect(result.content).toBeNull();
  });

  test('extracts delta.tool_calls', () => {
    const json = JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'tap', arguments: '{"x":0.5}' } }] } }]
    });
    const result = LLMClient.parseSSELine(`data: ${json}`);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('tap');
  });

  test('returns nulls for invalid JSON', () => {
    const result = LLMClient.parseSSELine('data: {bad}');
    expect(result.content).toBeNull();
    expect(result.toolCalls).toBeNull();
  });

  test('returns nulls for non-data lines', () => {
    const result = LLMClient.parseSSELine('event: message');
    expect(result.content).toBeNull();
  });
});

describe('LLMClient.sendStreamingRequest', () => {
  let client;

  beforeEach(() => {
    client = new LLMClient();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('streams content and calls onComplete', async () => {
    const chunk1 = JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] });
    const chunk2 = JSON.stringify({ choices: [{ delta: { content: ' World' } }] });
    const sseData = `data: ${chunk1}\n\ndata: ${chunk2}\n\ndata: [DONE]\n\n`;

    global.fetch.mockResolvedValue({ ok: true, body: createMockReadableStream([sseData]) });

    const onChunk = jest.fn();
    const onComplete = jest.fn();

    await client.sendStreamingRequest(onChunk, onComplete, jest.fn());

    expect(onChunk).toHaveBeenCalledWith('Hello', 'content');
    expect(onChunk).toHaveBeenCalledWith(' World', 'content');
    expect(onComplete).toHaveBeenCalledWith('Hello World', '', null);
  });

  test('accumulates tool_calls from streaming', async () => {
    const tc1 = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'tap', arguments: '{"x"' } }] } }] });
    const tc2 = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':0.5,"y":0.3}' } }] } }] });
    const sseData = `data: ${tc1}\n\ndata: ${tc2}\n\ndata: [DONE]\n\n`;

    global.fetch.mockResolvedValue({ ok: true, body: createMockReadableStream([sseData]) });

    const onComplete = jest.fn();
    await client.sendStreamingRequest(jest.fn(), onComplete, jest.fn());

    const toolCalls = onComplete.mock.calls[0][2];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe('call_1');
    expect(toolCalls[0].function.name).toBe('tap');
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ x: 0.5, y: 0.3 });
  });

  test('calls onError on non-ok response', async () => {
    global.fetch.mockResolvedValue({
      ok: false, status: 500, statusText: 'Error',
      text: jest.fn().mockResolvedValue('fail')
    });

    const onError = jest.fn();
    await client.sendStreamingRequest(jest.fn(), jest.fn(), onError);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('sends tools in request body', async () => {
    global.fetch.mockResolvedValue({ ok: true, body: createMockReadableStream(['data: [DONE]\n\n']) });

    await client.sendStreamingRequest(jest.fn(), jest.fn(), jest.fn());

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.tools).toBeDefined();
    expect(body.tool_choice).toBe('auto');
    expect(body.tools.length).toBeGreaterThan(0);
  });
});
