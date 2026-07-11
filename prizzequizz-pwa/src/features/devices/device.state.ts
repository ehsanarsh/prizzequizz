const DEVICE_ID_KEY = 'pq_device_id_v1';

export function getClientDeviceId(): string {
  try {
    let current = localStorage.getItem(DEVICE_ID_KEY);
    if (!current) {
      current = `dev_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}_${Date.now()}`;
      localStorage.setItem(DEVICE_ID_KEY, current);
    }
    return current;
  } catch {
    return `dev_memory_${Date.now()}`;
  }
}

export function getDeviceFingerprint(): string {
  const parts = [
    getClientDeviceId(),
    navigator.userAgent,
    navigator.language,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    `${screen.width}x${screen.height}`,
    navigator.platform
  ];
  return parts.join('|');
}

export function getPlatformLabel(): string {
  return navigator.platform || 'web';
}
