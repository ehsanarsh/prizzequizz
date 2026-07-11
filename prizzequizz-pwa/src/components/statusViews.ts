export function skeletonList(count = 3): string {
  return `<div class="skeleton-list">${Array.from({ length: count })
    .map(() => '<div class="skeleton-card"><i></i><b></b><span></span></div>')
    .join('')}</div>`;
}

export function emptyState(icon: string, title: string, text: string): string {
  return `<div class="empty-state rich"><div class="empty-icon">${icon}</div><b>${title}</b><p>${text}</p></div>`;
}

export function errorState(message: string, retryAction: string): string {
  return `<div class="error-state"><div class="empty-icon">⚠️</div><b>مشکلی پیش آمد</b><p>${message}</p><button class="primary" data-action="${retryAction}">تلاش دوباره</button></div>`;
}
