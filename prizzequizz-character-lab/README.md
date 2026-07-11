# PrizzeQuizz Character Lab — PWA Character System

A lightweight, production-oriented character customization system for a Progressive Web App.

## Architecture

The character is split into two independent systems:

### 1. State System

Each character state is a separate image asset:

- `idle`
- `happy`
- `sad`
- `win`
- `lose`

These are rendered as the base layer.

### 2. Outfit System

Outfits are transparent PNG overlays stacked on top of the base character.

Slots:

- `head`
- `body`
- `shoes`

Each slot is independent, so the UI can update one layer without re-rendering the whole character.

## Rendering

DOM layering is used instead of canvas:

```html
<div id="characterPreview">
  <img data-layer="base" />
  <img data-layer="body" />
  <img data-layer="shoes" />
  <img data-layer="head" />
</div>
```

This is intentionally simple, fast, and mobile-friendly.

## Folder Structure

```text
/assets
  /states
    idle.png
    happy.png
    sad.png
    win.png
    lose.png
  /outfits
    /head
    /body
    /shoes
/data
  character.json
/js
  character.js
  renderer.js
  stateManager.js
index.html
manifest.webmanifest
sw.js
```

## Performance Notes

- No React/Vue dependency.
- Minimal DOM updates.
- Only `src` attributes are swapped.
- Assets are preloaded before UI is marked ready.
- Service worker caches core assets for offline use.
- State is persisted in `localStorage`.

## Development

Run with any static server:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080/prizze-pwa-character/
```

Service worker requires HTTP(S), not `file://`.
