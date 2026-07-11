let sheetRoot: HTMLElement | null = null;

export function showBottomSheet(content: string): void {
  hideBottomSheet();
  sheetRoot = document.createElement('div');
  sheetRoot.className = 'sheet-backdrop';
  sheetRoot.innerHTML = `<div class="bottom-sheet"><div class="grab"></div>${content}</div>`;
  sheetRoot.addEventListener('pointerdown', (event) => {
    if (event.target === sheetRoot) hideBottomSheet();
  });
  document.body.appendChild(sheetRoot);
  requestAnimationFrame(() => sheetRoot?.classList.add('show'));
}

export function hideBottomSheet(): void {
  if (!sheetRoot) return;
  const root = sheetRoot;
  root.classList.remove('show');
  window.setTimeout(() => root.remove(), 200);
  sheetRoot = null;
}
