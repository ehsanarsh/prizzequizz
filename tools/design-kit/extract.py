#!/usr/bin/env python3
"""Pull the CSS, the theme tokens, the embedded pictures and fonts, and the
list of names the game's JavaScript holds on to, out of the one-file client.

Run after the two capture scripts:

    node tools/design-kit/capture-screens.mjs   OUT
    node tools/design-kit/capture-overlays.mjs  OUT
    python3 tools/design-kit/extract.py         OUT

What comes out is a package a designer can work from without ever opening the
game's source — and, just as important, without being able to hand back a
modified game file.
"""
import re, io, os, sys, json, base64, collections

OUT = sys.argv[1] if len(sys.argv) > 1 else 'design-kit'
SRC = sys.argv[2] if len(sys.argv) > 2 else 'prizze-v643.html'
s = io.open(SRC, encoding='utf-8').read()
for d in ('css', 'assets'):
    os.makedirs(os.path.join(OUT, d), exist_ok=True)

# ── the CSS, with its pictures and fonts pulled out into real files ──────────
css = '\n\n'.join(re.findall(r'<style[^>]*>(.*?)</style>', s, re.S))
seen = {}

def stash(m, kind, exts):
    key = m.group(0)
    if key not in seen:
        ext = exts.get(m.group(1), 'bin')
        name = f'{kind}-{len(seen) + 1:02d}.{ext}'
        data = m.group(2)
        io.open(os.path.join(OUT, 'assets', name), 'wb').write(
            base64.b64decode(data + '=' * (-len(data) % 4)))
        seen[key] = name
    return f'url(../assets/{seen[key]})'

css = re.sub(r'url\(data:(font/woff2?);base64,([A-Za-z0-9+/=]+)\)',
             lambda m: stash(m, 'font', {'font/woff2': 'woff2', 'font/woff': 'woff'}), css)
css = re.sub(r'data:(image/[a-z+.-]+);base64,([A-Za-z0-9+/=]+)',
             lambda m: stash(m, 'bg', {'image/png': 'png', 'image/webp': 'webp',
                                       'image/jpeg': 'jpg', 'image/svg+xml': 'svg',
                                       'image/gif': 'gif'})[4:-1], css)
io.open(os.path.join(OUT, 'css', 'game.css'), 'w', encoding='utf-8').write(css)

# ── the theme, on its own, because it is the cheapest redesign there is ──────
toks = collections.OrderedDict()
for m in re.finditer(r'(--[a-z0-9-]+)\s*:\s*([^;{}]+);', css):
    toks.setdefault(m.group(1), m.group(2).strip())
io.open(os.path.join(OUT, 'css', 'tokens.css'), 'w', encoding='utf-8').write(
    ':root{\n' + '\n'.join(f'  {k}: {v};' for k, v in toks.items()) + '\n}\n')

# ── THE CONTRACT: every name the JavaScript looks up. ───────────────────────
# A redesign that renames one of these breaks that part of the game silently,
# because nothing throws — the element is simply never found.
js = '\n'.join(re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', s, re.S))
ids = sorted(set(re.findall(r"getElementById\(\s*['\"]([A-Za-z0-9_-]+)['\"]", js)
                 + re.findall(r"querySelector(?:All)?\(\s*['\"]#([A-Za-z0-9_-]+)", js)))
cls = sorted(set(re.findall(r"classList\.(?:add|remove|toggle|contains)\(\s*['\"]([A-Za-z0-9_-]+)['\"]", js)
                 + re.findall(r"querySelector(?:All)?\(\s*['\"]\.([A-Za-z0-9_-]+)", js)
                 + re.findall(r"getElementsByClassName\(\s*['\"]([A-Za-z0-9_-]+)['\"]", js)))
json.dump({'ids': ids, 'classes': cls},
          io.open(os.path.join(OUT, 'contract.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)

print(f'css/game.css   {len(css) / 1024:6.0f} KB')
print(f'css/tokens.css {len(toks):6d} tokens')
print(f'assets/        {len(seen):6d} files')
print(f'contract.json  {len(ids)} ids, {len(cls)} classes')
