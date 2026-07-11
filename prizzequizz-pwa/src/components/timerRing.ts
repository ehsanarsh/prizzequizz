export function timerRing(id: string, value: number): string {
  return `<div class="timer-ring" id="${id}" aria-label="timer">
    <svg viewBox="0 0 56 56"><circle cx="28" cy="28" r="24"/><path d="M28 4a24 24 0 1 1 0 48a24 24 0 1 1 0-48"/></svg>
    <b>${toFa(value)}</b>
  </div>`;
}

function toFa(n: number): string {
  return Number(n).toLocaleString('fa-IR');
}
