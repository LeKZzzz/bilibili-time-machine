import { describe, expect, it } from 'vitest';
import { createDiagnosticEvent, createMemoryDiagnosticSink, redactUrl } from '../../src/core/diagnostics';

describe('core diagnostics', () => {
  it('redacts query, hash, cookies and response-like fields', () => {
    expect(redactUrl('https://www.bilibili.com/video/BV1?token=secret#x')).toEqual({
      host: 'www.bilibili.com', path: '/video/BV1',
    });
    const event = createDiagnosticEvent({
      reason: 'parse-failed',
      url: 'https://www.bilibili.com/x?cookie=secret',
      message: 'safe message',
      details: { content: 'comment body', count: 2 },
    });
    expect(event.host).toBe('www.bilibili.com');
    expect(event.path).toBe('/x');
    expect(event.details).toEqual({ count: 2 });
    expect(JSON.stringify(event)).not.toContain('secret');
  });

  it('does not emit when debug is disabled', () => {
    const sink = createMemoryDiagnosticSink(false);
    expect(sink.events).toHaveLength(0);
  });
});

