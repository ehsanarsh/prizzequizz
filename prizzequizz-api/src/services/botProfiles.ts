export interface BotProfile {
  id: string;
  username: string;
  avatar: string;
  skill: number;
  personality: 'fast' | 'balanced' | 'careful';
}

const bots: BotProfile[] = [
  { id: 'bot_fox_fast', username: 'FoxRush', avatar: '🦊', skill: 850, personality: 'fast' },
  { id: 'bot_panda_calm', username: 'PandaMind', avatar: '🐼', skill: 980, personality: 'careful' },
  { id: 'bot_tiger_pro', username: 'TigerQuiz', avatar: '🐯', skill: 1180, personality: 'balanced' },
  { id: 'bot_alien_x', username: 'AlienXP', avatar: '👾', skill: 1320, personality: 'fast' }
];

export function pickBotProfile(targetSkill: number): BotProfile {
  return [...bots].sort((a, b) => Math.abs(a.skill - targetSkill) - Math.abs(b.skill - targetSkill))[0] ?? bots[0]!;
}
