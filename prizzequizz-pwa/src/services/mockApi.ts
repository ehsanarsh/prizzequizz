import { api } from '../api';
import type { Question } from '../types/app';

export const mockApi = {
  async getNextQuestion(): Promise<Question> {
    return api.questions.next();
  },
  async submitAnswer(questionId: string, selectedIndex: number): Promise<{ correct: boolean; correctIndex: number }> {
    const response = await api.questions.submitAnswer({
      matchId: 'local_mock_match',
      questionId,
      selectedIndex,
      answerTimeMs: 0,
      idempotencyKey: `local_${questionId}_${selectedIndex}_${Date.now()}`
    });
    return { correct: response.correct, correctIndex: response.correctIndex };
  }
};
