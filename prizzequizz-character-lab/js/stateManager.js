const STORAGE_KEY = 'pq-character-state-v1';

export class StateManager {
  constructor(config) {
    this.config = config;
    this.state = this.load() ?? structuredClone(config.initial);
    this.listeners = new Set();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Storage can be unavailable in private mode; app still works in memory.
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  emit() {
    this.save();
    for (const listener of this.listeners) listener(this.state);
  }

  setState(nextState) {
    if (!this.config.states[nextState]) return;
    this.state.state = nextState;
    this.emit();
  }

  setOutfit(slot, item) {
    if (!this.config.outfits[slot]?.items[item]) return;
    this.state.outfit[slot] = item;
    this.emit();
  }

  reset() {
    this.state = structuredClone(this.config.initial);
    this.emit();
  }
}
