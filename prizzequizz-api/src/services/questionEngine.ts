import { repositories } from '../repositories/index.js';
import type { Question } from '../types/domain.js';

let cursor = 0;

export async function nextQuestion(): Promise<Question> {
  const questions = await repositories.questions.listApproved();
  if (!questions.length) throw new Error('NO_QUESTIONS');
  const q = questions[cursor % questions.length]!;
  cursor += 1;
  return q;
}

export async function validateAnswer(questionId: string, selectedIndex: number): Promise<{ correct: boolean; correctIndex: number }> {
  const q = await repositories.questions.findById(questionId);
  if (!q) throw new Error('QUESTION_NOT_FOUND');
  return { correct: selectedIndex === q.correctIndex, correctIndex: q.correctIndex };
}
