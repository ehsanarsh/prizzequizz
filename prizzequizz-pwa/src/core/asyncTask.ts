import { eventBus } from './eventBus';
import { store } from './stateStore';
import { normalizeUnknownError } from '../api/errors';

export async function runTask<T>(key: string, task: () => Promise<T>): Promise<T | null> {
  store.set((draft) => {
    draft.ui.loading[key] = true;
    draft.ui.errors[key] = null;
    draft.ui.lastFailedAction = null;
  });
  try {
    return await task();
  } catch (error) {
    const normalized = normalizeUnknownError(error);
    store.set((draft) => {
      draft.ui.errors[key] = normalized.message;
      draft.ui.lastFailedAction = key;
    });
    eventBus.emit('API_ERROR', { ...normalized, key });
    return null;
  } finally {
    store.set((draft) => {
      draft.ui.loading[key] = false;
    });
  }
}
