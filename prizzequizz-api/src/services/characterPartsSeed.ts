/* CHARACTER BUILDER — vector seed set (yellow-monster style).
 *
 * Every part is a FULL 300x300 transparent SVG so layers stack on the SAME
 * canvas at the SAME anchors and NOTHING shifts when a part is swapped. Anchors
 * shared by all parts:
 *   body    : ellipse  cx150 cy175 rx95 ry105
 *   eyes    : center   150,130  (single) / 120,132 & 180,132 (double)
 *   eyebrows: above eyes ~y104
 *   horns   : bases     110,78 & 190,78
 *   hair/hat: crown      cy ~72
 *   arms    : shoulders  y185, hands out to x40 / x260
 *   legs    : hips       y270 down to feet y292
 *   shoes   : feet       120/180 , y286
 *   beard   : chin       cy ~250
 *   glasses : over eyes  y128
 *
 * These are intentionally simple, cohesive placeholders the user can later
 * replace with real PNGs from the admin panel — no code change needed, just add
 * a part with the same category. */

export interface SeedPart { category: string; name: string; imageUrl: string; sortOrder: number; }

// Wrap an inner SVG body into a full-canvas data URI. utf8 + encodeURIComponent
// keeps '#', '<', quotes etc. valid inside a data: URL.
function svg(inner: string): string {
  const doc =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300">${inner}</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(doc);
}

const STROKE = '#2a1c00';

// ---------------------------------------------------------------- BODY
const BODY_COLORS: Array<[string, string, string]> = [
  ['زرد کلاسیک', '#FFD21F', '#F2B705'],
  ['نارنجی', '#FF9F1C', '#F27A0A'],
  ['سبز لجنی', '#8FC93A', '#5FA02A'],
  ['آبی یخی', '#4CC3F2', '#1FA3D8'],
  ['بنفش', '#B15CE0', '#8E3CC0'],
  ['صورتی', '#FF7EB3', '#F0508E'],
  ['قرمز', '#FF5A4D', '#E23A2E'],
  ['فیروزه‌ای', '#2DD4BF', '#12A897'],
  ['قهوه‌ای', '#C08A4E', '#9A6A34'],
  ['خاکستری', '#B8C0CC', '#939DAC'],
  ['کرم', '#F4E3B2', '#E0C983'],
  ['مشکی براق', '#3A3F4A', '#20242C']
];
function bodies(): SeedPart[] {
  return BODY_COLORS.map(([name, top, bot], i) => {
    const gid = 'bg' + i;
    const inner =
      `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bot}"/></linearGradient></defs>` +
      `<ellipse cx="150" cy="175" rx="95" ry="105" fill="url(#${gid})" stroke="${STROKE}" stroke-width="4"/>` +
      // soft belly highlight
      `<ellipse cx="150" cy="200" rx="60" ry="62" fill="#ffffff" opacity="0.10"/>`;
    return { category: 'body', name, imageUrl: svg(inner), sortOrder: i };
  });
}

// ---------------------------------------------------------------- EYES (single / cyclops)
function eyesSingle(): SeedPart[] {
  const cx = 150, cy = 130;
  const variants: Array<[string, string]> = [
    ['تک‌چشم گرد', `<circle cx="${cx}" cy="${cy}" r="34" fill="#fff" stroke="${STROKE}" stroke-width="4"/><circle cx="${cx}" cy="${cy}" r="15" fill="#1b1b1b"/><circle cx="${cx - 6}" cy="${cy - 6}" r="5" fill="#fff"/>`],
    ['تک‌چشم بزرگ', `<circle cx="${cx}" cy="${cy}" r="42" fill="#fff" stroke="${STROKE}" stroke-width="4"/><circle cx="${cx}" cy="${cy}" r="19" fill="#2b6cff"/><circle cx="${cx}" cy="${cy}" r="9" fill="#111"/><circle cx="${cx - 7}" cy="${cy - 8}" r="6" fill="#fff"/>`],
    ['تک‌چشم خواب‌آلود', `<circle cx="${cx}" cy="${cy}" r="34" fill="#fff" stroke="${STROKE}" stroke-width="4"/><circle cx="${cx}" cy="${cy + 4}" r="14" fill="#1b1b1b"/><path d="M${cx - 36} ${cy - 4} q36 -22 72 0" fill="#F2B705" stroke="${STROKE}" stroke-width="4"/>`],
    ['تک‌چشم عصبانی', `<circle cx="${cx}" cy="${cy}" r="34" fill="#fff" stroke="${STROKE}" stroke-width="4"/><circle cx="${cx}" cy="${cy + 3}" r="15" fill="#c0261b"/><circle cx="${cx}" cy="${cy + 3}" r="7" fill="#111"/>`],
    ['تک‌چشم قلب', `<circle cx="${cx}" cy="${cy}" r="34" fill="#fff" stroke="${STROKE}" stroke-width="4"/><path d="M${cx} ${cy + 12} C${cx - 20} ${cy - 6} ${cx - 6} ${cy - 20} ${cx} ${cy - 8} C${cx + 6} ${cy - 20} ${cx + 20} ${cy - 6} ${cx} ${cy + 12} Z" fill="#ff3d6e"/>`],
    ['تک‌چشم ستاره', `<circle cx="${cx}" cy="${cy}" r="34" fill="#fff" stroke="${STROKE}" stroke-width="4"/><path d="M${cx} ${cy - 18} l6 12 13 2 -9 9 2 13 -12 -6 -12 6 2 -13 -9 -9 13 -2 Z" fill="#F5A800"/>`],
    ['تک‌چشم مارپیچ', `<circle cx="${cx}" cy="${cy}" r="34" fill="#fff" stroke="${STROKE}" stroke-width="4"/><path d="M${cx} ${cy} m0 -14 a14 14 0 1 1 -12 20 a9 9 0 1 1 10 -13" fill="none" stroke="#111" stroke-width="4"/>`],
    ['تک‌چشم پول', `<circle cx="${cx}" cy="${cy}" r="34" fill="#fff" stroke="${STROKE}" stroke-width="4"/><text x="${cx}" y="${cy + 11}" font-size="30" text-anchor="middle" fill="#1a8a3a" font-family="Arial" font-weight="bold">$</text>`],
    ['تک‌چشم سایبورگ', `<circle cx="${cx}" cy="${cy}" r="34" fill="#111" stroke="${STROKE}" stroke-width="4"/><circle cx="${cx}" cy="${cy}" r="10" fill="#ff2d2d"/><circle cx="${cx}" cy="${cy}" r="20" fill="none" stroke="#ff2d2d" stroke-width="2" opacity="0.6"/>`],
    ['تک‌چشم چپ‌نگاه', `<circle cx="${cx}" cy="${cy}" r="34" fill="#fff" stroke="${STROKE}" stroke-width="4"/><circle cx="${cx - 12}" cy="${cy - 6}" r="14" fill="#1b1b1b"/><circle cx="${cx - 16}" cy="${cy - 10}" r="5" fill="#fff"/>`]
  ];
  return variants.map(([name, s], i) => ({ category: 'eyesSingle', name, imageUrl: svg(s), sortOrder: i }));
}

// ---------------------------------------------------------------- EYES (double)
function eyesDouble(): SeedPart[] {
  const lx = 120, rx = 180, cy = 132;
  const eye = (x: number, pupilDx: number, r: number, iris: string) =>
    `<circle cx="${x}" cy="${cy}" r="${r}" fill="#fff" stroke="${STROKE}" stroke-width="4"/>` +
    `<circle cx="${x + pupilDx}" cy="${cy}" r="${Math.round(r * 0.45)}" fill="${iris}"/>` +
    `<circle cx="${x + pupilDx}" cy="${cy}" r="${Math.round(r * 0.2)}" fill="#111"/>` +
    `<circle cx="${x + pupilDx - 4}" cy="${cy - 4}" r="3" fill="#fff"/>`;
  const variants: Array<[string, string]> = [
    ['دو چشم گرد', eye(lx, 0, 26, '#1b1b1b') + eye(rx, 0, 26, '#1b1b1b')],
    ['دو چشم آبی', eye(lx, 0, 26, '#2b6cff') + eye(rx, 0, 26, '#2b6cff')],
    ['دو چشم سبز', eye(lx, 0, 26, '#1a9e4b') + eye(rx, 0, 26, '#1a9e4b')],
    ['نگاه به چپ', eye(lx, -8, 26, '#1b1b1b') + eye(rx, -8, 26, '#1b1b1b')],
    ['نگاه به راست', eye(lx, 8, 26, '#1b1b1b') + eye(rx, 8, 26, '#1b1b1b')],
    ['چشم درشت', eye(lx, 0, 32, '#1b1b1b') + eye(rx, 0, 32, '#1b1b1b')],
    ['چشم ریز', eye(lx, 0, 18, '#1b1b1b') + eye(rx, 0, 18, '#1b1b1b')],
    ['ناهماهنگ', eye(lx, -6, 30, '#1b1b1b') + eye(rx, 6, 20, '#1b1b1b')],
    ['خواب‌آلود', `<path d="M${lx - 26} ${cy} q26 18 52 0" fill="none" stroke="${STROKE}" stroke-width="5" stroke-linecap="round"/><path d="M${rx - 26} ${cy} q26 18 52 0" fill="none" stroke="${STROKE}" stroke-width="5" stroke-linecap="round"/>`],
    ['قلبی', `<path d="M${lx} ${cy + 10} C${lx - 16} ${cy - 6} ${lx - 4} ${cy - 18} ${lx} ${cy - 8} C${lx + 4} ${cy - 18} ${lx + 16} ${cy - 6} ${lx} ${cy + 10} Z" fill="#ff3d6e"/><path d="M${rx} ${cy + 10} C${rx - 16} ${cy - 6} ${rx - 4} ${cy - 18} ${rx} ${cy - 8} C${rx + 4} ${cy - 18} ${rx + 16} ${cy - 6} ${rx} ${cy + 10} Z" fill="#ff3d6e"/>`],
    ['ضربدری', `<g stroke="${STROKE}" stroke-width="5" stroke-linecap="round"><path d="M${lx - 14} ${cy - 14} l28 28"/><path d="M${lx + 14} ${cy - 14} l-28 28"/><path d="M${rx - 14} ${cy - 14} l28 28"/><path d="M${rx + 14} ${cy - 14} l-28 28"/></g>`]
  ];
  return variants.map(([name, s], i) => ({ category: 'eyesDouble', name, imageUrl: svg(s), sortOrder: i }));
}

// ---------------------------------------------------------------- EYEBROWS
function eyebrows(): SeedPart[] {
  const lx = 120, rx = 180, y = 100;
  const brow = (x: number, d: string) => `<path d="${d.replace(/@/g, String(x))}" fill="none" stroke="${STROKE}" stroke-width="6" stroke-linecap="round"/>`;
  const set = (dL: string, dR: string) => brow(lx, dL) + brow(rx, dR);
  const variants: Array<[string, string]> = [
    ['صاف', set(`M@-22 ${y} h44`, `M@-22 ${y} h44`)],
    ['عصبانی', set(`M@-22 ${y + 8} l44 -12`, `M@-22 ${y - 4} l44 12`)],
    ['متعجب', set(`M@-22 ${y} q22 -16 44 0`, `M@-22 ${y} q22 -16 44 0`)],
    ['غمگین', set(`M@-22 ${y - 6} q22 14 44 4`, `M@-22 ${y + 4} q22 -10 44 -4`)],
    ['پرپشت', `<path d="M${lx - 24} ${y} q24 -10 48 0 v8 q-24 -6 -48 0 Z" fill="${STROKE}"/><path d="M${rx - 24} ${y} q24 -10 48 0 v8 q-24 -6 -48 0 Z" fill="${STROKE}"/>`],
    ['نازک', set(`M@-20 ${y} q20 -6 40 0`, `M@-20 ${y} q20 -6 40 0`)],
    ['یک‌ابرو بالا', set(`M@-22 ${y} h44`, `M@-22 ${y - 10} q22 -8 44 0`)],
    ['موجی', set(`M@-22 ${y} q11 -10 22 0 q11 10 22 0`, `M@-22 ${y} q11 -10 22 0 q11 10 22 0`)],
    ['خشمگین پررنگ', `<path d="M${lx - 24} ${y + 10} l48 -14 v9 l-48 12 Z" fill="${STROKE}"/><path d="M${rx - 24} ${y - 4} l48 14 v9 l-48 -12 Z" fill="${STROKE}"/>`],
    ['کوتاه', set(`M@-14 ${y} h28`, `M@-14 ${y} h28`)]
  ];
  return variants.map(([name, s], i) => ({ category: 'eyebrows', name, imageUrl: svg(s), sortOrder: i }));
}

// ---------------------------------------------------------------- HORNS
function horns(): SeedPart[] {
  const lx = 110, rx = 190, base = 78;
  const horn = (x: number, dir: number, d: string, fill: string) =>
    `<path d="${d}" fill="${fill}" stroke="${STROKE}" stroke-width="4" stroke-linejoin="round" transform="translate(${x} ${base}) scale(${dir} 1)"/>`;
  const pair = (d: string, fill: string) => horn(0, 1, d, fill) + horn(0, -1, d, fill).replace(`translate(0 ${base})`, `translate(${rx - lx} ${base})`);
  // Build explicit pairs to keep anchors exact.
  function P(d: string, fill: string): string {
    return `<path d="${d}" transform="translate(${lx} ${base})" fill="${fill}" stroke="${STROKE}" stroke-width="4" stroke-linejoin="round"/>` +
           `<path d="${d}" transform="translate(${rx} ${base}) scale(-1 1)" fill="${fill}" stroke="${STROKE}" stroke-width="4" stroke-linejoin="round"/>`;
  }
  const variants: Array<[string, string]> = [
    ['شاخ کلاسیک زرد', P('M0 0 C-2 -30 8 -44 16 -40 C10 -20 6 -8 6 0 Z', '#FFD21F')],
    ['شاخ قرمز', P('M0 0 C-2 -34 10 -50 18 -44 C11 -22 6 -8 6 0 Z', '#E23A2E')],
    ['شاخ کوتاه', P('M0 0 C-1 -18 7 -26 12 -24 C8 -12 5 -5 5 0 Z', '#C08A4E')],
    ['شاخ پیچ‌دار', P('M0 0 C-4 -18 6 -22 4 -34 C2 -44 12 -40 12 -46', '#8FC93A')],
    ['شاخ تیز بلند', P('M0 0 L4 -2 L11 -52 L2 -6 Z', '#B8C0CC')],
    ['شاخ خمیده', P('M0 0 C-4 -26 4 -46 22 -46 C14 -40 8 -22 6 0 Z', '#7A5AE0')],
    ['شاخ استخوانی', P('M0 0 C-2 -28 6 -42 14 -40 C9 -22 5 -8 5 0 Z', '#F4E3B2')],
    ['شاخ آبی یخی', P('M0 0 C-2 -30 8 -46 16 -42 C10 -22 6 -8 6 0 Z', '#4CC3F2')],
    ['شاخ دوگانه', P('M0 0 C-2 -20 4 -30 8 -28 C5 -16 4 -6 4 0 Z M6 -2 C6 -22 12 -30 16 -26 C11 -16 9 -6 8 0 Z', '#FF9F1C')],
    ['شاخ صاف عمودی', P('M-1 0 L-3 -46 L5 -46 L3 0 Z', '#3A3F4A')]
  ];
  return variants.map(([name, s], i) => ({ category: 'horns', name, imageUrl: svg(s), sortOrder: i }));
}

// ---------------------------------------------------------------- HAIR
function hair(): SeedPart[] {
  const cx = 150;
  const variants: Array<[string, string]> = [
    ['فشن سیخی', `<path d="M100 90 q-6 -40 20 -30 q6 -34 30 -18 q24 -16 30 18 q26 -10 20 30 q-50 -20 -100 0 Z" fill="#3A2B1A" stroke="${STROKE}" stroke-width="3"/>`],
    ['فرفری', `<g fill="#2A1C10" stroke="${STROKE}" stroke-width="2"><circle cx="${cx - 40}" cy="86" r="16"/><circle cx="${cx - 16}" cy="72" r="18"/><circle cx="${cx + 12}" cy="72" r="18"/><circle cx="${cx + 38}" cy="86" r="16"/><circle cx="${cx}" cy="80" r="18"/></g>`],
    ['موهاوک', `<path d="M${cx - 8} 92 q8 -60 16 0 Z" fill="#E23A2E" stroke="${STROKE}" stroke-width="3"/>`],
    ['بلوند صاف', `<path d="M104 96 q-6 -46 46 -46 q52 0 46 46 q-46 -18 -92 0 Z" fill="#F2C14E" stroke="${STROKE}" stroke-width="3"/>`],
    ['کچل با تک‌تار', `<path d="M148 60 q2 -12 4 0" fill="none" stroke="${STROKE}" stroke-width="3"/>`],
    ['دم‌اسبی', `<path d="M104 92 q-4 -42 46 -42 q50 0 46 42 q-46 -18 -92 0 Z" fill="#4A3320" stroke="${STROKE}" stroke-width="3"/><path d="M196 84 q26 6 18 40 q-4 12 -14 6 q10 -26 -4 -46 Z" fill="#4A3320" stroke="${STROKE}" stroke-width="3"/>`],
    ['سیخی آبی', `<path d="M104 92 l10 -34 6 26 12 -40 8 30 12 -34 8 30 12 -24 6 22 q-46 -16 -92 0 Z" fill="#2b6cff" stroke="${STROKE}" stroke-width="3"/>`],
    ['کوتاه مرتب', `<path d="M108 88 q-2 -34 42 -34 q44 0 42 34 q-42 -14 -84 0 Z" fill="#20242C" stroke="${STROKE}" stroke-width="3"/>`],
    ['دو گیس', `<path d="M108 88 q-2 -34 42 -34 q44 0 42 34 q-42 -14 -84 0 Z" fill="#6B4423" stroke="${STROKE}" stroke-width="3"/><g fill="#6B4423" stroke="${STROKE}" stroke-width="3"><path d="M104 84 q-14 30 -4 52 q10 6 14 -4 q-8 -24 4 -44 Z"/><path d="M196 84 q14 30 4 52 q-10 6 -14 -4 q8 -24 -4 -44 Z"/></g>`],
    ['رنگین‌کمان', `<path d="M104 92 q-6 -46 46 -46 q52 0 46 46 q-46 -18 -92 0 Z" fill="#ff4fa3" stroke="${STROKE}" stroke-width="3"/><path d="M120 60 q30 -14 60 0" fill="none" stroke="#2bd4ff" stroke-width="6"/><path d="M116 74 q34 -12 68 0" fill="none" stroke="#8FC93A" stroke-width="6"/>`]
  ];
  return variants.map(([name, s], i) => ({ category: 'hair', name, imageUrl: svg(s), sortOrder: i }));
}

// ---------------------------------------------------------------- HAT
function hat(): SeedPart[] {
  const cx = 150;
  const variants: Array<[string, string]> = [
    ['کلاه پارتی', `<path d="M${cx} 30 l30 56 h-60 Z" fill="#E23A2E" stroke="${STROKE}" stroke-width="3"/><circle cx="${cx}" cy="30" r="6" fill="#FFD21F" stroke="${STROKE}" stroke-width="2"/>`],
    ['سیلندر', `<rect x="${cx - 26}" y="40" width="52" height="48" rx="4" fill="#20242C" stroke="${STROKE}" stroke-width="3"/><rect x="${cx - 40}" y="84" width="80" height="10" rx="5" fill="#20242C" stroke="${STROKE}" stroke-width="3"/><rect x="${cx - 26}" y="72" width="52" height="8" fill="#E23A2E"/>`],
    ['کلاه نوک‌تیز جادوگر', `<path d="M${cx} 24 l34 64 h-68 Z" fill="#5B2A86" stroke="${STROKE}" stroke-width="3"/><rect x="${cx - 42}" y="84" width="84" height="10" rx="5" fill="#5B2A86" stroke="${STROKE}" stroke-width="3"/><path d="M${cx - 6} 60 l6 -6 6 6 -6 6 Z" fill="#FFD21F"/>`],
    ['کلاه بیسبال', `<path d="M${cx - 34} 84 q0 -42 34 -42 q34 0 34 42 q-34 -14 -68 0 Z" fill="#2b6cff" stroke="${STROKE}" stroke-width="3"/><path d="M${cx + 20} 84 q34 2 40 16 q-24 6 -44 -2 Z" fill="#1f4fd8" stroke="${STROKE}" stroke-width="3"/>`],
    ['تاج', `<path d="M${cx - 34} 88 l0 -30 14 16 20 -30 20 30 14 -16 0 30 Z" fill="#FFC61A" stroke="${STROKE}" stroke-width="3"/><circle cx="${cx}" cy="70" r="4" fill="#E23A2E"/>`],
    ['کلاه بره', `<path d="M${cx - 30} 82 q0 -34 30 -34 q30 0 30 34 q-30 -12 -60 0 Z" fill="#3A3F4A" stroke="${STROKE}" stroke-width="3"/><circle cx="${cx - 30}" cy="64" r="8" fill="#E23A2E" stroke="${STROKE}" stroke-width="2"/>`],
    ['کلاه بابانوئل', `<path d="M${cx - 30} 86 q0 -46 34 -44 q40 2 30 40 Z" fill="#E23A2E" stroke="${STROKE}" stroke-width="3"/><rect x="${cx - 34}" y="82" width="72" height="12" rx="6" fill="#fff" stroke="${STROKE}" stroke-width="2"/><circle cx="${cx + 30}" cy="46" r="8" fill="#fff" stroke="${STROKE}" stroke-width="2"/>`],
    ['هاله فرشته', `<ellipse cx="${cx}" cy="46" rx="34" ry="10" fill="none" stroke="#FFD21F" stroke-width="6"/>`],
    ['شاخک بیگانه', `<g stroke="${STROKE}" stroke-width="4" fill="none"><path d="M${cx - 14} 82 q-8 -30 -18 -34"/><path d="M${cx + 14} 82 q8 -30 18 -34"/></g><circle cx="${cx - 34}" cy="46" r="7" fill="#8FC93A" stroke="${STROKE}" stroke-width="2"/><circle cx="${cx + 34}" cy="46" r="7" fill="#8FC93A" stroke="${STROKE}" stroke-width="2"/>`],
    ['کلاه گاوچران', `<path d="M${cx - 30} 80 q6 -32 30 -32 q24 0 30 32 q-30 -12 -60 0 Z" fill="#8B5A2B" stroke="${STROKE}" stroke-width="3"/><path d="M${cx - 46} 84 q46 18 92 0 q-14 14 -46 14 q-32 0 -46 -14 Z" fill="#8B5A2B" stroke="${STROKE}" stroke-width="3"/>`]
  ];
  return variants.map(([name, s], i) => ({ category: 'hat', name, imageUrl: svg(s), sortOrder: i }));
}

// ---------------------------------------------------------------- GLASSES
function glasses(): SeedPart[] {
  const lx = 120, rx = 180, y = 130;
  const round = (stroke: string, fill: string) =>
    `<g stroke="${stroke}" stroke-width="5" fill="${fill}"><circle cx="${lx}" cy="${y}" r="24"/><circle cx="${rx}" cy="${y}" r="24"/><path d="M${lx + 24} ${y} h${rx - lx - 48}" fill="none"/><path d="M${lx - 24} ${y} h-14" fill="none"/><path d="M${rx + 24} ${y} h14" fill="none"/></g>`;
  const rect = (stroke: string, fill: string) =>
    `<g stroke="${stroke}" stroke-width="5" fill="${fill}"><rect x="${lx - 26}" y="${y - 16}" width="52" height="32" rx="6"/><rect x="${rx - 26}" y="${y - 16}" width="52" height="32" rx="6"/><path d="M${lx + 26} ${y} h${rx - lx - 52}" fill="none"/></g>`;
  const variants: Array<[string, string]> = [
    ['گرد شفاف', round(STROKE, 'rgba(255,255,255,0.15)')],
    ['آفتابی مشکی', round(STROKE, '#1b1b1b')],
    ['مربعی شفاف', rect(STROKE, 'rgba(255,255,255,0.15)')],
    ['آفتابی آبی', round(STROKE, 'rgba(43,108,255,0.55)')],
    ['قلبی', `<g stroke="#ff3d6e" stroke-width="5" fill="rgba(255,61,110,0.35)"><path d="M${lx} ${y + 16} C${lx - 26} ${y - 8} ${lx - 8} ${y - 26} ${lx} ${y - 10} C${lx + 8} ${y - 26} ${lx + 26} ${y - 8} ${lx} ${y + 16} Z"/><path d="M${rx} ${y + 16} C${rx - 26} ${y - 8} ${rx - 8} ${y - 26} ${rx} ${y - 10} C${rx + 8} ${y - 26} ${rx + 26} ${y - 8} ${rx} ${y + 16} Z"/></g>`],
    ['گرد طلایی', round('#E0A11B', 'rgba(255,255,255,0.12)')],
    ['پنجه‌گربه', `<g stroke="${STROKE}" stroke-width="5" fill="#20242C"><path d="M${lx - 26} ${y - 14} q4 -14 26 -10 q22 -4 26 10 v22 q-26 8 -52 0 Z"/><path d="M${rx - 26} ${y - 14} q4 -14 26 -10 q22 -4 26 10 v22 q-26 8 -52 0 Z"/></g>`],
    ['اسکی', `<rect x="${lx - 30}" y="${y - 20}" width="120" height="40" rx="20" fill="rgba(120,200,255,0.35)" stroke="${STROKE}" stroke-width="5"/>`],
    ['تک‌عدسی (مونوکل)', `<circle cx="${rx}" cy="${y}" r="24" fill="rgba(255,255,255,0.15)" stroke="#E0A11B" stroke-width="5"/><path d="M${rx} ${y + 24} l-6 40" fill="none" stroke="#E0A11B" stroke-width="3"/>`],
    ['هشت‌ضلعی', `<g stroke="${STROKE}" stroke-width="5" fill="rgba(255,255,255,0.12)"><path d="M${lx - 14} ${y - 22} h28 l14 14 v16 l-14 14 h-28 l-14 -14 v-16 Z"/><path d="M${rx - 14} ${y - 22} h28 l14 14 v16 l-14 14 h-28 l-14 -14 v-16 Z"/></g>`]
  ];
  return variants.map(([name, s], i) => ({ category: 'glasses', name, imageUrl: svg(s), sortOrder: i }));
}

// ---------------------------------------------------------------- ARMS
function arms(): SeedPart[] {
  const sY = 185;
  // Left arm from body edge (~x60) out; right mirrored (~x240).
  const A = (dL: string, dR: string, fill: string) =>
    `<path d="${dL}" fill="${fill}" stroke="${STROKE}" stroke-width="4" stroke-linejoin="round"/>` +
    `<path d="${dR}" fill="${fill}" stroke="${STROKE}" stroke-width="4" stroke-linejoin="round"/>`;
  const variants: Array<[string, string, string, string]> = [
    ['دست‌های آویزان', `M64 ${sY} q-26 6 -26 40 q0 14 12 14 q10 0 10 -14 q0 -22 12 -30 Z`, `M236 ${sY} q26 6 26 40 q0 14 -12 14 q-10 0 -10 -14 q0 -22 -12 -30 Z`, '#F2B705'],
    ['دست بالا (سلام)', `M64 ${sY} q-30 -6 -34 -44 q-2 -14 10 -16 q10 -2 12 12 q4 24 12 32 Z`, `M236 ${sY} q30 -6 34 -44 q2 -14 -10 -16 q-10 -2 -12 12 q-4 24 -12 32 Z`, '#F2B705'],
    ['دست به کمر', `M64 ${sY} q-24 4 -22 30 q1 12 14 10 q10 -2 6 -14 q-2 -14 2 -22 Z`, `M236 ${sY} q24 4 22 30 q-1 12 -14 10 q-10 -2 -6 -14 q2 -14 -2 -22 Z`, '#F2B705'],
    ['تفنگ انگشتی', `M64 ${sY} q-28 -2 -34 -20 q-6 -14 8 -16 q-6 -8 4 -10 q6 8 6 14 q10 12 12 22 Z`, `M236 ${sY} q28 -2 34 -20 q6 -14 -8 -16 q6 -8 -4 -10 q-6 8 -6 14 q-10 12 -12 22 Z`, '#F2B705'],
    ['عضلانی', `M62 ${sY} q-34 8 -30 44 q2 16 16 14 q12 -2 8 -18 q-4 -22 6 -34 Z`, `M238 ${sY} q34 8 30 44 q-2 16 -16 14 q-12 -2 -8 -18 q4 -22 -6 -34 Z`, '#F2B705'],
    ['دست‌های باز', `M64 ${sY} q-40 -2 -50 8 q-8 8 2 12 q14 4 30 -6 q10 -6 18 -6 Z`, `M236 ${sY} q40 -2 50 8 q8 8 -2 12 q-14 4 -30 -6 q-10 -6 -18 -6 Z`, '#F2B705'],
    ['شست بالا', `M64 ${sY} q-26 -4 -28 -28 q-1 -12 10 -12 q8 0 8 10 q10 6 10 18 Z`, `M236 ${sY} q26 -4 28 -28 q1 -12 -10 -12 q-8 0 -8 10 q-10 6 -10 18 Z`, '#F2B705'],
    ['دست رباتی', `M64 ${sY} h-26 v-8 h-14 v34 h14 v-8 h26 Z`, `M236 ${sY} h26 v-8 h14 v34 h-14 v-8 h-26 Z`, '#B8C0CC'],
    ['پنجه', `M64 ${sY} q-26 8 -26 34 l6 2 4 -10 4 12 5 -12 4 12 5 -12 q0 -18 -6 -26 Z`, `M236 ${sY} q26 8 26 34 l-6 2 -4 -10 -4 12 -5 -12 -4 12 -5 -12 q0 -18 6 -26 Z`, '#8FC93A'],
    ['دست‌های نازک', `M66 ${sY} q-18 8 -18 36 q0 10 8 10 q7 0 7 -10 q0 -20 8 -30 Z`, `M234 ${sY} q18 8 18 36 q0 10 -8 10 q-7 0 -7 -10 q0 -20 -8 -30 Z`, '#F2B705']
  ];
  return variants.map(([name, dL, dR, fill], i) => ({ category: 'arms', name, imageUrl: svg(A(dL, dR, fill)), sortOrder: i }));
}

// ---------------------------------------------------------------- LEGS
function legs(): SeedPart[] {
  const y = 268;
  const L = (dL: string, dR: string, fill: string) =>
    `<path d="${dL}" fill="${fill}" stroke="${STROKE}" stroke-width="4" stroke-linejoin="round"/>` +
    `<path d="${dR}" fill="${fill}" stroke="${STROKE}" stroke-width="4" stroke-linejoin="round"/>`;
  const variants: Array<[string, string, string, string]> = [
    ['پاهای کوتاه', `M120 ${y} q-8 0 -8 14 v6 q0 6 8 6 q8 0 8 -6 v-6 q0 -14 -8 -14 Z`, `M180 ${y} q-8 0 -8 14 v6 q0 6 8 6 q8 0 8 -6 v-6 q0 -14 -8 -14 Z`, '#F2B705'],
    ['پاهای بلند', `M120 ${y} q-8 0 -8 20 v12 q0 6 8 6 q8 0 8 -6 v-12 q0 -20 -8 -20 Z`, `M180 ${y} q-8 0 -8 20 v12 q0 6 8 6 q8 0 8 -6 v-12 q0 -20 -8 -20 Z`, '#F2B705'],
    ['پاهای چاق', `M118 ${y} q-12 0 -12 16 v6 q0 6 12 6 q12 0 12 -6 v-6 q0 -16 -12 -16 Z`, `M182 ${y} q-12 0 -12 16 v6 q0 6 12 6 q12 0 12 -6 v-6 q0 -16 -12 -16 Z`, '#F2B705'],
    ['پاهای لاغر', `M121 ${y} q-5 0 -5 18 v8 q0 5 5 5 q5 0 5 -5 v-8 q0 -18 -5 -18 Z`, `M179 ${y} q-5 0 -5 18 v8 q0 5 5 5 q5 0 5 -5 v-8 q0 -18 -5 -18 Z`, '#F2B705'],
    ['پاهای رباتی', `M112 ${y} h16 v20 h-16 Z`, `M172 ${y} h16 v20 h-16 Z`, '#B8C0CC'],
    ['پاهای فنری', `M120 ${y} q-10 4 0 8 q10 4 0 8 q-10 4 0 8 v4 q0 4 0 4`, `M180 ${y} q10 4 0 8 q-10 4 0 8 q10 4 0 8 v4 q0 4 0 4`, '#B8C0CC'],
    ['پاهای پرمو', `M120 ${y} q-9 0 -9 16 l4 -2 3 6 3 -8 3 8 3 -6 3 2 q0 -16 -9 -16 Z`, `M180 ${y} q-9 0 -9 16 l4 -2 3 6 3 -8 3 8 3 -6 3 2 q0 -16 -9 -16 Z`, '#8FC93A'],
    ['پاهای آبی', `M120 ${y} q-8 0 -8 18 v8 q0 6 8 6 q8 0 8 -6 v-8 q0 -18 -8 -18 Z`, `M180 ${y} q-8 0 -8 18 v8 q0 6 8 6 q8 0 8 -6 v-8 q0 -18 -8 -18 Z`, '#4CC3F2'],
    ['پاهای پرانتزی', `M122 ${y} q-14 6 -10 24 q1 5 6 4 q4 -1 2 -6 q-2 -12 8 -18 Z`, `M178 ${y} q14 6 10 24 q-1 5 -6 4 q-4 -1 -2 -6 q2 -12 -8 -18 Z`, '#F2B705'],
    ['پاهای ورزشی', `M120 ${y} q-7 0 -7 16 v8 q0 6 7 6 q7 0 7 -6 v-8 q0 -16 -7 -16 Z`, `M180 ${y} q-7 0 -7 16 v8 q0 6 7 6 q7 0 7 -6 v-8 q0 -16 -7 -16 Z`, '#FF9F1C']
  ];
  return variants.map(([name, dL, dR, fill], i) => ({ category: 'legs', name, imageUrl: svg(L(dL, dR, fill)), sortOrder: i }));
}

// ---------------------------------------------------------------- SHOES
function shoes(): SeedPart[] {
  const y = 288, lx = 120, rx = 180;
  const S = (fill: string, d: string) =>
    `<path d="${d.replace(/@X/g, String(lx))}" fill="${fill}" stroke="${STROKE}" stroke-width="4" stroke-linejoin="round"/>` +
    `<path d="${d.replace(/@X/g, String(rx))}" fill="${fill}" stroke="${STROKE}" stroke-width="4" stroke-linejoin="round"/>`;
  const variants: Array<[string, string, string]> = [
    ['کتانی سفید', '#f2f2f2', `M@X-12 ${y} q-8 0 -8 8 q0 6 8 6 h20 q6 0 6 -6 q0 -8 -8 -8 Z`],
    ['کتانی قرمز', '#E23A2E', `M@X-12 ${y} q-8 0 -8 8 q0 6 8 6 h20 q6 0 6 -6 q0 -8 -8 -8 Z`],
    ['چکمه', '#5A3B1A', `M@X-10 ${y - 6} h14 v6 q6 0 6 8 q0 6 -8 6 h-20 q-6 0 -6 -6 v-14 Z`],
    ['کفش رسمی', '#20242C', `M@X-12 ${y + 2} q-8 0 -8 6 q0 6 10 6 h22 q4 0 4 -6 q0 -8 -12 -8 Z`],
    ['دمپایی', '#4CC3F2', `M@X-12 ${y + 3} h26 q4 0 4 5 q0 4 -6 4 h-22 q-4 0 -4 -4 Z`],
    ['کفش ورزشی سبز', '#8FC93A', `M@X-12 ${y} q-8 0 -8 8 q0 6 8 6 h20 q6 0 6 -6 q0 -8 -8 -8 Z`],
    ['کفش برفی', '#dbe9ff', `M@X-13 ${y - 2} q-9 0 -9 9 q0 7 9 7 h22 q7 0 7 -7 q0 -9 -9 -9 Z`],
    ['کتانی بنفش', '#B15CE0', `M@X-12 ${y} q-8 0 -8 8 q0 6 8 6 h20 q6 0 6 -6 q0 -8 -8 -8 Z`],
    ['پاشنه‌بلند', '#ff3d6e', `M@X-12 ${y + 2} q-6 0 -6 6 h18 l6 8 4 -2 -4 -12 Z`],
    ['پابرهنه (بدون کفش)', 'none', `M@X ${y} m0 0`]
  ];
  return variants.map(([name, fill, d], i) => ({ category: 'shoes', name, imageUrl: svg(S(fill, d)), sortOrder: i }));
}

// ---------------------------------------------------------------- BEARD
function beard(): SeedPart[] {
  const cx = 150, cy = 244;
  const variants: Array<[string, string]> = [
    ['ریش کوتاه', `<path d="M${cx - 44} ${cy - 24} q44 40 88 0 q-6 40 -44 44 q-38 -4 -44 -44 Z" fill="#3A2B1A" stroke="${STROKE}" stroke-width="3"/>`],
    ['ریش بلند', `<path d="M${cx - 40} ${cy - 24} q40 34 80 0 q-2 60 -40 74 q-38 -14 -40 -74 Z" fill="#20242C" stroke="${STROKE}" stroke-width="3"/>`],
    ['سبیل', `<path d="M${cx - 30} ${cy - 30} q14 12 30 12 q16 0 30 -12 q-6 16 -30 16 q-24 0 -30 -16 Z" fill="#3A2B1A" stroke="${STROKE}" stroke-width="3"/>`],
    ['بزی', `<path d="M${cx - 12} ${cy} q12 24 24 0 q-2 26 -12 30 q-10 -4 -12 -30 Z" fill="#20242C" stroke="${STROKE}" stroke-width="3"/>`],
    ['ریش سفید بابانوئل', `<path d="M${cx - 46} ${cy - 26} q46 44 92 0 q-4 56 -46 66 q-42 -10 -46 -66 Z" fill="#f2f2f2" stroke="${STROKE}" stroke-width="3"/>`],
    ['ریش قرمز', `<path d="M${cx - 42} ${cy - 24} q42 38 84 0 q-4 46 -42 52 q-38 -6 -42 -52 Z" fill="#B5462B" stroke="${STROKE}" stroke-width="3"/>`],
    ['ته‌ریش', `<path d="M${cx - 44} ${cy - 22} q44 40 88 0 q-6 34 -44 38 q-38 -4 -44 -38 Z" fill="#3A2B1A" opacity="0.5"/>`],
    ['سبیل تابدار', `<path d="M${cx - 34} ${cy - 30} q16 10 34 10 q18 0 34 -10 q-4 8 -12 12 q10 2 16 -6 q-6 16 -22 12 q-16 4 -16 -6 q0 10 -16 6 q-16 4 -22 -12 q6 8 16 6 q-8 -4 -12 -12 Z" fill="#20242C" stroke="${STROKE}" stroke-width="2"/>`],
    ['ریش دوشاخه', `<path d="M${cx - 40} ${cy - 24} q40 34 80 0 q-6 30 -26 40 q-14 -20 -14 -34 q0 14 -14 34 q-20 -10 -26 -40 Z" fill="#2A1C10" stroke="${STROKE}" stroke-width="3"/>`],
    ['ریش سبز جادویی', `<path d="M${cx - 42} ${cy - 24} q42 38 84 0 q-4 50 -42 58 q-38 -8 -42 -58 Z" fill="#3FA34D" stroke="${STROKE}" stroke-width="3"/>`]
  ];
  return variants.map(([name, s], i) => ({ category: 'beard', name, imageUrl: svg(s), sortOrder: i }));
}

// ---------------------------------------------------------------- ACCESSORIES
function accessories(): SeedPart[] {
  const cx = 150;
  const variants: Array<[string, string]> = [
    ['پاپیون', `<g transform="translate(${cx} 250)"><path d="M0 0 l-22 -12 v24 Z" fill="#E23A2E" stroke="${STROKE}" stroke-width="3"/><path d="M0 0 l22 -12 v24 Z" fill="#E23A2E" stroke="${STROKE}" stroke-width="3"/><circle r="6" fill="#B5231A" stroke="${STROKE}" stroke-width="2"/></g>`],
    ['گردنبند طلا', `<path d="M${cx - 40} 250 q40 40 80 0" fill="none" stroke="#FFC61A" stroke-width="5"/><circle cx="${cx}" cy="272" r="8" fill="#FFC61A" stroke="${STROKE}" stroke-width="2"/>`],
    ['کراوات', `<path d="M${cx - 8} 244 h16 l-4 10 8 40 -12 16 -12 -16 8 -40 Z" fill="#2b6cff" stroke="${STROKE}" stroke-width="3"/>`],
    ['شنل', `<path d="M110 200 q40 24 80 0 l24 80 q-64 24 -128 0 Z" fill="#5B2A86" stroke="${STROKE}" stroke-width="3" opacity="0.92"/>`],
    ['بال‌های فرشته', `<g fill="#ffffff" stroke="${STROKE}" stroke-width="3" opacity="0.9"><path d="M64 170 q-44 -10 -50 40 q30 -20 52 -8 Z"/><path d="M236 170 q44 -10 50 40 q-30 -20 -52 -8 Z"/></g>`],
    ['دم شیطانی', `<path d="M232 210 q40 10 34 60 q-2 14 -12 10 q6 -30 -8 -40 l-4 8 -6 -14 Z" fill="#E23A2E" stroke="${STROKE}" stroke-width="3"/>`],
    ['ساعت مچی', `<g transform="translate(48 232)"><rect x="-10" y="-10" width="20" height="20" rx="4" fill="#20242C" stroke="${STROKE}" stroke-width="3"/><circle r="6" fill="#4CC3F2"/></g>`],
    ['مدال قهرمانی', `<path d="M${cx - 14} 238 l14 20 14 -20" fill="none" stroke="#E23A2E" stroke-width="4"/><circle cx="${cx}" cy="270" r="14" fill="#FFC61A" stroke="${STROKE}" stroke-width="3"/><text x="${cx}" y="275" font-size="14" text-anchor="middle" fill="${STROKE}" font-family="Arial" font-weight="bold">۱</text>`],
    ['شال‌گردن', `<path d="M112 232 q38 20 76 0 v14 q-38 18 -76 0 Z" fill="#E23A2E" stroke="${STROKE}" stroke-width="3"/><path d="M180 244 l10 40 12 -4 -8 -40 Z" fill="#E23A2E" stroke="${STROKE}" stroke-width="3"/>`],
    ['کوله‌پشتی', `<path d="M96 190 q-18 4 -18 40 l14 4 q4 -30 12 -34 Z" fill="#3FA34D" stroke="${STROKE}" stroke-width="3"/>`]
  ];
  return variants.map(([name, s], i) => ({ category: 'accessories', name, imageUrl: svg(s), sortOrder: i }));
}

export function buildSeedParts(): SeedPart[] {
  return [
    ...bodies(),
    ...eyesSingle(),
    ...eyesDouble(),
    ...eyebrows(),
    ...horns(),
    ...hair(),
    ...hat(),
    ...glasses(),
    ...arms(),
    ...legs(),
    ...shoes(),
    ...beard(),
    ...accessories()
  ];
}
