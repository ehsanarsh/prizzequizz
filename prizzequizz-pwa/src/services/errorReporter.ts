import { api } from '../api';
import { getClientDeviceId } from '../features/devices/device.state';

let installed = false;
let reporting = false;

export function installClientErrorReporter(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (event) => {
    void reportClientError({
      severity: 'error',
      message: event.message || 'Unhandled error',
      stack: event.error?.stack,
      metadata: { filename: event.filename, lineno: event.lineno, colno: event.colno }
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    void reportClientError({
      severity: 'fatal',
      message: reason instanceof Error ? reason.message : String(reason ?? 'Unhandled promise rejection'),
      stack: reason instanceof Error ? reason.stack : undefined,
      metadata: { type: 'unhandledrejection' }
    });
  });
}

export async function reportClientError(input: { severity?: 'info' | 'warn' | 'error' | 'fatal'; message: string; stack?: string; metadata?: Record<string, unknown> }): Promise<void> {
  if (reporting) return;
  reporting = true;
  try {
    await api.monitoring.report({
      source: 'frontend',
      severity: input.severity ?? 'error',
      message: input.message,
      stack: input.stack,
      route: location.pathname + location.hash,
      userAgent: navigator.userAgent,
      appVersion: import.meta.env.VITE_APP_VERSION ?? 'dev',
      buildId: import.meta.env.VITE_BUILD_ID ?? 'local',
      deviceId: getClientDeviceId(),
      metadata: input.metadata ?? {}
    });
  } catch {
    // Avoid recursive reporting loops; failed telemetry must never break the app.
  } finally {
    reporting = false;
  }
}
