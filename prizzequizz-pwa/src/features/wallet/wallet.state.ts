import { api } from '../../api';
import { store } from '../../core/stateStore';
import { runTask } from '../../core/asyncTask';
import { eventBus } from '../../core/eventBus';

export type WalletTab = 'overview' | 'transactions' | 'cards' | 'security';
export type TxnStatus = 'ok' | 'pending' | 'paid';
export type TxnType = 'topup' | 'withdraw' | 'game' | 'win' | 'reward';

export interface WalletTxn {
  id: string;
  icon: string;
  title: string;
  time: string;
  amount: number;
  positive: boolean;
  status: TxnStatus;
  type: TxnType;
  ref: string;
}

export interface BankCard {
  id: string;
  bank: string;
  masked: string;
  iban: string;
  isDefault: boolean;
  verified: boolean;
}

const TXN_KEY = 'prizzequizz-wallet-txns-v1';
const CARD_KEY = 'prizzequizz-wallet-cards-v1';

let activeTab: WalletTab = 'overview';
let hydrated = false;

let txns: WalletTxn[] = load<WalletTxn[]>(TXN_KEY) ?? [
  { id: 't1', icon: '🏆', title: 'برد دوئل ۱به‌۱', time: 'امروز ۱۴:۳۰', amount: 180000, positive: true, status: 'ok', type: 'win', ref: 'PQ-WIN-1001' },
  { id: 't2', icon: '⚔️', title: 'ورودی مسابقه', time: 'امروز ۱۳:۱۰', amount: 60000, positive: false, status: 'ok', type: 'game', ref: 'PQ-GAME-8821' },
  { id: 't3', icon: '↑', title: 'برداشت به کارت بانکی', time: 'دیروز ۱۹:۴۵', amount: 250000, positive: false, status: 'paid', type: 'withdraw', ref: 'WD-7742' }
];

let cards: BankCard[] = load<BankCard[]>(CARD_KEY) ?? [
  { id: 'c1', bank: 'بانک ملت', masked: '**** **** **** ۴۲۱۸', iban: 'IR1201200000000004218', isDefault: true, verified: true }
];

export function getWalletTab(): WalletTab { return activeTab; }
export function setWalletTab(tab: WalletTab): void { activeTab = tab; }
export function getTransactions(): WalletTxn[] { return txns; }
export function getCards(): BankCard[] { return cards; }
export function isWalletHydrated(): boolean { return hydrated; }

export async function hydrateWallet(): Promise<void> {
  if (hydrated) return;
  await runTask('wallet.hydrate', async () => {
    const dto = await api.wallet.get();
    store.set((draft) => {
      draft.economy.wallet = dto.wallet;
      draft.economy.coins = dto.coins;
      draft.economy.hearts = dto.hearts;
      draft.economy.tickets = dto.tickets;
    });
    if (dto.transactions?.length) {
      txns = dto.transactions.map((t) => ({
        id: t.id,
        icon: t.direction === 'in' ? '＋' : '↑',
        title: t.type,
        time: new Date(t.createdAt).toLocaleString('fa-IR'),
        amount: t.amount,
        positive: t.direction === 'in',
        status: t.status === 'failed' ? 'ok' : t.status,
        type: t.type as TxnType,
        ref: t.reference ?? t.id
      }));
      save(TXN_KEY, txns);
    }
    hydrated = true;
  });
}

export async function topupWallet(amount: number): Promise<void> {
  await runTask('wallet.topup', async () => {
    if (api.payments) {
      const intent = await api.payments.createIntent({ amount, idempotencyKey: `pwa_topup_${Date.now()}` });
      const paid = await api.payments.verifyIntent(intent.id, 'paid');
      if (paid.status !== 'paid') throw new Error('پرداخت ناموفق بود');
      await hydrateWalletFresh();
    } else {
      const dto = await api.wallet.topup(amount);
      store.set((draft) => { draft.economy.wallet = dto.wallet; });
    }
    addTransaction({ icon: '＋', title: 'شارژ کیف پول', amount, positive: true, status: 'ok', type: 'topup' });
    eventBus.emit('WALLET_TOPUP', { amount });
  });
}

async function hydrateWalletFresh(): Promise<void> {
  const dto = await api.wallet.get();
  store.set((draft) => {
    draft.economy.wallet = dto.wallet;
    draft.economy.coins = dto.coins;
    draft.economy.hearts = dto.hearts;
    draft.economy.tickets = dto.tickets;
  });
}

export async function requestWithdraw(amount: number): Promise<boolean> {
  const result = await runTask('wallet.withdraw', async () => {
    const wallet = store.get().economy.wallet;
    if (amount < 50000) throw new Error('حداقل برداشت ۵۰٬۰۰۰ تومان است');
    if (amount > wallet) throw new Error('مبلغ برداشت بیشتر از موجودی است');
    const dto = await api.wallet.withdraw(amount);
    store.set((draft) => { draft.economy.wallet = dto.wallet; });
    addTransaction({ icon: '↑', title: 'برداشت به کارت بانکی', amount, positive: false, status: 'pending', type: 'withdraw' });
    eventBus.emit('WITHDRAW_REQUESTED', { amount });
    return true;
  });
  return !!result;
}

export function addBankCard(bank: string, cardNumber: string, iban: string): boolean {
  const digits = cardNumber.replace(/\D/g, '');
  if (!bank.trim() || digits.length < 16 || !iban.toUpperCase().startsWith('IR')) return false;
  cards.push({ id: `c${Date.now()}`, bank: bank.startsWith('بانک') ? bank : `بانک ${bank}`, masked: `**** **** **** ${digits.slice(-4)}`, iban: iban.toUpperCase(), isDefault: cards.length === 0, verified: true });
  save(CARD_KEY, cards);
  return true;
}

export function setDefaultCard(id: string): void { cards = cards.map((card) => ({ ...card, isDefault: card.id === id })); save(CARD_KEY, cards); }
export function removeCard(id: string): boolean { if (cards.length <= 1) return false; cards = cards.filter((card) => card.id !== id); if (!cards.some((card) => card.isDefault) && cards[0]) cards[0].isDefault = true; save(CARD_KEY, cards); return true; }

export function addTransaction(input: Omit<WalletTxn, 'id' | 'time' | 'ref'>): void {
  txns.unshift({ ...input, id: `t${Date.now()}`, time: 'همین حالا', ref: `PQ-${Math.floor(Math.random() * 90000 + 10000)}` });
  save(TXN_KEY, txns);
}

function load<T>(key: string): T | null { try { return JSON.parse(localStorage.getItem(key) || 'null') as T | null; } catch { return null; } }
function save<T>(key: string, value: T): void { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
