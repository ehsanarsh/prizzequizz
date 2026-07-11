import { StateManager } from './stateManager.js';
import { CharacterRenderer } from './renderer.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const config = await fetch('./data/character.json').then((res) => res.json());
const manager = new StateManager(config);
const renderer = new CharacterRenderer(config, $('#characterPreview'));

const ui = {
  stateGrid: $('#stateGrid'),
  slotTabs: $('#slotTabs'),
  outfitGrid: $('#outfitGrid'),
  currentState: $('#currentState'),
  currentOutfit: $('#currentOutfit'),
  reset: $('#resetButton'),
  install: $('#installButton')
};

let activeSlot = 'head';
let deferredPrompt = null;

function createButton({ className, label, meta, icon, active, onClick }) {
  const button = document.createElement('button');
  button.className = className + (active ? ' is-active' : '');
  button.type = 'button';
  button.innerHTML = `
    <span class="choice-icon">${icon ?? ''}</span>
    <span class="choice-copy">
      <b>${label}</b>
      ${meta ? `<small>${meta}</small>` : ''}
    </span>
  `;
  button.addEventListener('click', onClick);
  return button;
}

function renderStateButtons(characterState) {
  ui.stateGrid.innerHTML = '';

  for (const [key, state] of Object.entries(config.states)) {
    ui.stateGrid.append(
      createButton({
        className: 'choice-card',
        label: state.title,
        meta: state.label,
        icon: stateIcon(key),
        active: key === characterState.state,
        onClick: () => manager.setState(key)
      })
    );
  }
}

function renderSlotTabs(characterState) {
  ui.slotTabs.innerHTML = '';

  for (const [slot, slotConfig] of Object.entries(config.outfits)) {
    const currentItem = slotConfig.items[characterState.outfit[slot]];
    ui.slotTabs.append(
      createButton({
        className: 'slot-tab',
        label: slotConfig.label,
        meta: currentItem?.title ?? '—',
        icon: slotIcon(slot),
        active: slot === activeSlot,
        onClick: () => {
          activeSlot = slot;
          manager.emit();
        }
      })
    );
  }
}

function renderOutfitButtons(characterState) {
  const slot = config.outfits[activeSlot];
  ui.outfitGrid.innerHTML = '';

  for (const [itemKey, item] of Object.entries(slot.items)) {
    ui.outfitGrid.append(
      createButton({
        className: 'choice-card outfit-card',
        label: item.title,
        meta: itemKey,
        icon: outfitIcon(activeSlot, itemKey),
        active: characterState.outfit[activeSlot] === itemKey,
        onClick: () => manager.setOutfit(activeSlot, itemKey)
      })
    );
  }
}

function renderMeta(characterState) {
  ui.currentState.textContent = config.states[characterState.state].title;
  ui.currentOutfit.textContent = Object.entries(characterState.outfit)
    .map(([slot, itemKey]) => `${config.outfits[slot].label}: ${config.outfits[slot].items[itemKey].title}`)
    .join(' · ');
}

function stateIcon(key) {
  return { idle: '🙂', happy: '😄', sad: '😔', win: '🏆', lose: '💥' }[key] ?? '✨';
}

function slotIcon(slot) {
  return { head: '🎩', body: '👕', shoes: '👟' }[slot] ?? '✨';
}

function outfitIcon(slot, item) {
  if (item === 'none') return '—';
  return { head: '🎩', body: '👕', shoes: '👟' }[slot] ?? '✨';
}

await renderer.preload();
document.body.classList.add('is-ready');

manager.subscribe((characterState) => {
  renderer.render(characterState);
  renderStateButtons(characterState);
  renderSlotTabs(characterState);
  renderOutfitButtons(characterState);
  renderMeta(characterState);
});

ui.reset.addEventListener('click', () => manager.reset());

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPrompt = event;
  ui.install.hidden = false;
});

ui.install.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  ui.install.hidden = true;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // PWA still works online if SW registration fails in a preview environment.
    });
  });
}
