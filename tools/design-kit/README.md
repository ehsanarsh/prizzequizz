# The design handoff kit

Regenerates the package a designer works from. Three commands:

```
node   tools/design-kit/capture-screens.mjs  design-kit
node   tools/design-kit/capture-overlays.mjs design-kit
python3 tools/design-kit/extract.py          design-kit
```

## Why it exists

The client is one 2.8 MB file: 55% JavaScript (half of that base64 pictures),
40% CSS, 4.5% HTML. Handing that to a designer means the thing they hand back is
a modified game file — design edits interleaved with matchmaking, scoring and
WebSocket code, with no way to tell which is which. This produces a package that
cannot contain game logic, so it cannot come back carrying any.

## What is captured, and how

Nothing here is written by hand. The game is booted in a real mobile browser
against a stubbed API, every screen is opened with the game's own `go()`, every
modal and sheet with the game's own opener, and what is saved is the DOM the
browser actually built plus a screenshot of it.

Two details that took a wrong first attempt to find:

* Several screens are an empty shell until a loader fills them — the button that
  normally opens them calls it afterwards. `FILL` in `capture-screens.mjs` names
  the game's own loader for each one.
* The first run came back with a tutorial card covering nearly every screen. The
  game's own «do not show again» flags are set before the run.

## The contract

`contract.json` lists every id and class the JavaScript looks up. Renaming one
breaks that part of the game **silently** — nothing throws, the element is just
never found. It is generated from the source, not maintained by hand, so it
cannot drift.
