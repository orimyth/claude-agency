import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, setLogLevel } from './logger.js';

describe('Logger', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    setLogLevel('debug');
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    setLogLevel('info');
  });

  it('outputs JSON to stdout for info', () => {
    const log = new Logger({ component: 'test' });
    log.info('hello');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const line = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line.trim());
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello');
    expect(parsed.component).toBe('test');
    expect(parsed.ts).toBeDefined();
  });

  it('outputs errors to stderr', () => {
    const log = new Logger();
    log.error('boom');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse((stderrSpy.mock.calls[0][0] as string).trim());
    expect(parsed.level).toBe('error');
    expect(parsed.msg).toBe('boom');
  });

  it('includes extra fields', () => {
    const log = new Logger({ service: 'api' });
    log.info('request', { method: 'GET', path: '/test' });
    const parsed = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(parsed.service).toBe('api');
    expect(parsed.method).toBe('GET');
    expect(parsed.path).toBe('/test');
  });

  it('child logger inherits and extends fields', () => {
    const parent = new Logger({ component: 'orchestrator' });
    const child = parent.child({ agentId: 'alice' });
    child.info('task done');
    const parsed = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(parsed.component).toBe('orchestrator');
    expect(parsed.agentId).toBe('alice');
  });

  it('respects log level filter', () => {
    setLogLevel('warn');
    const log = new Logger();
    log.debug('skip');
    log.info('skip');
    log.warn('show');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(parsed.msg).toBe('show');
  });

  it('supports all log levels', () => {
    const log = new Logger();
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    // debug + info + warn = 3 stdout, error = 1 stderr
    expect(stdoutSpy).toHaveBeenCalledTimes(3);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });
});
