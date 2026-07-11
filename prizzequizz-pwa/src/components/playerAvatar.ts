export function playerAvatar({ avatar, name, score, me = false }: { avatar: string; name: string; score?: number; me?: boolean }): string {
  return `<div class="player ${me ? 'me' : 'opp'}">
    <div class="avatar">${avatar}</div>
    <b>${name}</b>
    ${typeof score === 'number' ? `<em>${Number(score).toLocaleString('fa-IR')}</em>` : ''}
  </div>`;
}
