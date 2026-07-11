import type { Question } from '../types/app';

export const questionSeed: Question[] = [
  { id: 'q1', category: 'عمومی', difficulty: 'easy', text: 'یک هفته چند روز است؟', options: ['۵ روز', '۶ روز', '۷ روز', '۸ روز'], correctIndex: 2 },
  { id: 'q2', category: 'جغرافیا', difficulty: 'easy', text: 'پایتخت فرانسه کدام شهر است؟', options: ['رم', 'مادرید', 'پاریس', 'لندن'], correctIndex: 2 },
  { id: 'q3', category: 'علوم', difficulty: 'easy', text: 'فرمول شیمیایی آب چیست؟', options: ['CO2', 'H2O', 'O2', 'NaCl'], correctIndex: 1 },
  { id: 'q4', category: 'ورزش', difficulty: 'easy', text: 'در فوتبال هر تیم چند بازیکن دارد؟', options: ['۹', '۱۰', '۱۱', '۱۲'], correctIndex: 2 }
];
