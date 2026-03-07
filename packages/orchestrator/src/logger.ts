/**
 * Structured JSON logger for the orchestrator.
 * Outputs one JSON line per log entry to stdout/stderr.
 * Supports log levels, contextual fields, and child loggers.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

let minLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel) {
  minLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

function emit(entry: LogEntry) {
  const line = JSON.stringify(entry);
  if (entry.level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export class Logger {
  private fields: Record<string, unknown>;

  constructor(fields: Record<string, unknown> = {}) {
    this.fields = fields;
  }

  /** Create a child logger with additional context fields */
  child(fields: Record<string, unknown>): Logger {
    return new Logger({ ...this.fields, ...fields });
  }

  private log(level: LogLevel, msg: string, extra?: Record<string, unknown>) {
    if (!shouldLog(level)) return;
    emit({
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.fields,
      ...extra,
    });
  }

  debug(msg: string, extra?: Record<string, unknown>) { this.log('debug', msg, extra); }
  info(msg: string, extra?: Record<string, unknown>) { this.log('info', msg, extra); }
  warn(msg: string, extra?: Record<string, unknown>) { this.log('warn', msg, extra); }
  error(msg: string, extra?: Record<string, unknown>) { this.log('error', msg, extra); }
}

// Default root logger
export const logger = new Logger({ component: 'orchestrator' });
