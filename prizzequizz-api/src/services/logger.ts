export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  [key: string]: unknown;
}

const levelOrder: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

export const logger = {
  debug(message: string, context: LogContext = {}) { write('debug', message, context); },
  info(message: string, context: LogContext = {}) { write('info', message, context); },
  warn(message: string, context: LogContext = {}) { write('warn', message, context); },
  error(message: string, context: LogContext = {}) { write('error', message, context); }
};

function write(level: LogLevel, message: string, context: LogContext): void {
  if (levelOrder[level] < levelOrder[configuredLevel]) return;
  /* Context is spread FIRST so it can never overwrite the event name. Many call
     sites pass an error string as `message:` in the context — with the old
     order that replaced the event name, so grepping the logs for e.g.
     `push_notification_failed` found nothing and every failure looked
     anonymous. The caller's text is kept, just under `detail`. */
  const { message: shadowed, ...rest } = context as LogContext & { message?: unknown };
  const record = {
    ts: new Date().toISOString(),
    level,
    service: 'prizzequizz-api',
    message,
    ...rest,
    ...(shadowed === undefined ? {} : { detail: shadowed })
  };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
