import type { ScreenId } from '../types/app';
import { store } from './stateStore';

export function go(screen: ScreenId): void {
  store.set((state) => {
    state.ui.previousScreen = state.ui.currentScreen;
    state.ui.currentScreen = screen;
  });
}

export function back(fallback: ScreenId = 'home'): void {
  const prev = store.get().ui.previousScreen;
  go(prev ?? fallback);
}
