export class CharacterRenderer {
  constructor(config, root) {
    this.config = config;
    this.root = root;
    this.layers = {
      base: root.querySelector('[data-layer="base"]'),
      head: root.querySelector('[data-layer="head"]'),
      body: root.querySelector('[data-layer="body"]'),
      shoes: root.querySelector('[data-layer="shoes"]')
    };
  }

  preload() {
    const urls = [
      ...Object.values(this.config.states).map((state) => state.src),
      ...Object.values(this.config.outfits).flatMap((slot) =>
        Object.values(slot.items).map((item) => item.src)
      )
    ];

    return Promise.all(
      urls.map(
        (src) =>
          new Promise((resolve) => {
            const img = new Image();
            img.onload = img.onerror = resolve;
            img.src = src;
          })
      )
    );
  }

  render(characterState) {
    const base = this.config.states[characterState.state];
    this.setLayer(this.layers.base, base?.src, base?.title ?? 'character');

    for (const [slot, itemKey] of Object.entries(characterState.outfit)) {
      const item = this.config.outfits[slot]?.items[itemKey];
      this.setLayer(this.layers[slot], item?.src, item?.title ?? slot);
    }

    this.root.dataset.state = characterState.state;
  }

  setLayer(element, src, alt) {
    if (!element || !src) return;
    if (element.getAttribute('src') !== src) {
      element.src = src;
    }
    element.alt = alt;
  }
}
