import type { Question } from '../types/app';

export function answerGrid(question: Question | null): string {
  if (!question) return '<div class="answers skeleton"><button></button><button></button><button></button><button></button></div>';
  return `<div class="answers">${question.options.map((option, index) => `<button data-answer="${index}">${option}</button>`).join('')}</div>`;
}
