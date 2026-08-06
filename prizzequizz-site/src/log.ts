/* One-line JSON logs, same shape the API uses so both can be read together.
 *
 * `message` is the event name and nothing else. Passing an Error as `message`
 * inside the context — which is easy to do by accident — would overwrite the
 * event name and make the log unsearchable, so a `message` key in the context
 * is moved aside to `detail` instead. The API learned this the hard way.
 */
type Level = 'info' | 'warn' | 'error';

function write(level: Level, message: string, context: Record<string, unknown> = {}): void {
  const { message: shadowed, ...rest } = context as Record<string, unknown> & { message?: unknown };
  const record = {
    ts: new Date().toISOString(), level, service: 'prizzequizz-site', message, ...rest,
    ...(shadowed === undefined ? {} : { detail: shadowed })
  };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line); else console.log(line);
}

export const logger = {
  info: (m: string, c?: Record<string, unknown>) => write('info', m, c),
  warn: (m: string, c?: Record<string, unknown>) => write('warn', m, c),
  error: (m: string, c?: Record<string, unknown>) => write('error', m, c)
};
