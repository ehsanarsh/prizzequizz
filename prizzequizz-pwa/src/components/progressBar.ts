export function weeklyProgress(score: number): string {
  const targets = { bronze: 500, silver: 1500, gold: 3000 };
  const pct = Math.min(100, Math.round((score / targets.gold) * 100));
  return `<div class="weekly-line">
    <div class="line"><i style="width:${pct}%"></i><b style="left:${pct}%">● ${toFa(score)}</b></div>
    <div class="flags"><span>🏁 Bronze<br>۵۰۰</span><span>🏁 Silver<br>۱۵۰۰</span><span>🏁 Gold<br>۳۰۰۰</span></div>
  </div>`;
}

function toFa(n: number): string { return Number(n).toLocaleString('fa-IR'); }
