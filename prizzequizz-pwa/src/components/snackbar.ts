export interface SnackbarOptions {
  icon?: string;
  message: string;
  cta?: string;
  onClick?: () => void;
  timeoutMs?: number;
}

let snackbar: HTMLElement | null = null;
let timer = 0;

export function showSnackbar(options: SnackbarOptions): void {
  if (!snackbar) {
    snackbar = document.createElement('div');
    snackbar.className = 'smart-snackbar';
    document.body.appendChild(snackbar);
  }

  snackbar.innerHTML = `
    <div class="ss-icon">${options.icon ?? '⚠️'}</div>
    <div class="ss-text">${options.message}</div>
    ${options.cta ? `<button class="ss-cta">${options.cta}</button>` : ''}
  `;

  snackbar.querySelector<HTMLButtonElement>('.ss-cta')?.addEventListener('click', () => {
    hideSnackbar();
    options.onClick?.();
  });

  snackbar.classList.add('show');
  window.clearTimeout(timer);
  timer = window.setTimeout(hideSnackbar, options.timeoutMs ?? 3200);
}

export function hideSnackbar(): void {
  snackbar?.classList.remove('show');
}
