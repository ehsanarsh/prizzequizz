export interface ModalAction {
  label: string;
  variant?: 'primary' | 'ghost' | 'danger';
  onClick?: () => void;
}

export interface ModalOptions {
  icon?: string;
  title: string;
  body: string;
  actions?: ModalAction[];
  dismissible?: boolean;
  hideIcon?: boolean;
}

let modalRoot: HTMLElement | null = null;

export function showModal(options: ModalOptions): void {
  hideModal();
  modalRoot = document.createElement('div');
  modalRoot.className = 'modal-backdrop';
  modalRoot.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(options.title)}">
      ${options.hideIcon ? '' : `<div class="modal-icon">${options.icon ?? '✨'}</div>`}
      <h2>${options.title}</h2>
      <div class="modal-body">${options.body}</div>
      <div class="modal-actions"></div>
    </div>
  `;

  const actions = modalRoot.querySelector('.modal-actions') as HTMLElement;
  const modalActions = options.actions?.length ? options.actions : [{ label: 'باشه', variant: 'primary' as const }];
  modalActions.forEach((action) => {
    const button = document.createElement('button');
    button.className = `btn ${action.variant ?? 'primary'}`;
    button.textContent = action.label;
    button.addEventListener('click', () => {
      hideModal();
      action.onClick?.();
    });
    actions.appendChild(button);
  });

  if (options.dismissible !== false) {
    modalRoot.addEventListener('pointerdown', (event) => {
      if (event.target === modalRoot) hideModal();
    });
  }

  document.body.appendChild(modalRoot);
  requestAnimationFrame(() => modalRoot?.classList.add('show'));
}

export function hideModal(): void {
  if (!modalRoot) return;
  const root = modalRoot;
  root.classList.remove('show');
  window.setTimeout(() => root.remove(), 180);
  modalRoot = null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!));
}
