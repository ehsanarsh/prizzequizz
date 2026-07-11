import { eventBus } from '../core/eventBus';

let installed = false;

export function installNetworkStatus(): void {
  if (installed) return;
  installed = true;

  const emit = () => {
    eventBus.emit(navigator.onLine ? 'NETWORK_ONLINE' : 'NETWORK_OFFLINE', { online: navigator.onLine });
  };

  window.addEventListener('online', emit);
  window.addEventListener('offline', emit);
  emit();
}
