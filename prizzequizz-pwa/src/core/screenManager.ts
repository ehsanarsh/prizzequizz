import type { AppState, ScreenId } from '../types/app';

type ScreenRenderer = (state: AppState) => string;

type MountedHandler = (root: HTMLElement, state: AppState) => void;

export class ScreenManager {
  private screens = new Map<ScreenId, { render: ScreenRenderer; mounted?: MountedHandler }>();

  register(id: ScreenId, render: ScreenRenderer, mounted?: MountedHandler): void {
    this.screens.set(id, { render, mounted });
  }

  render(root: HTMLElement, state: AppState): void {
    const screen = this.screens.get(state.ui.currentScreen) ?? this.screens.get('home');
    if (!screen) return;
    root.innerHTML = screen.render(state);
    screen.mounted?.(root, state);
  }
}

export const screenManager = new ScreenManager();
