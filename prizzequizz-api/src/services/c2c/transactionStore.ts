/* DEPOSITS THE GAME KNOWS ABOUT.
 *
 * One row per transfer that arrived. This stage fills it by hand from the
 * panel; the SMS stages fill it from a forwarded message. Both write the same
 * row on purpose — the settlement path is built and proven against manual
 * entry before any Android code exists, so the first matching bug is found
 * with the operator's own test transfer instead of a player's money.
 *
 * Two rules are enforced here rather than trusted to callers:
 *
 * 1. AMOUNTS ARE RIAL, ALWAYS. The operator's banks disagree — Refah's SMS
 *    reports rial, others toman — so the unit is resolved at the edge and the
 *    column never holds an ambiguous number. A column that sometimes means
 *    toman is a ten-times error waiting for a busy evening.
 *
 * 2. ONE TRANSACTION PER SESSION, EVER. A partial unique index on session_id,
 *    not an application check: two deposits settling one order is two payments
 *    for one delivery, and the second is money the player has lost.
 */
import { getPgPool } from '../../database/postgres.js';
import { id } from '../../utils/id.js';

/* Only what this stage can actually produce. The parser states (MATCHED,
 * PARSE_FAILED, DUPLICATE…) arrive with the parser that produces them — a
 * status nothing writes is a state machine drawn on a whiteboard, not code. */
export const BANK_TX_STATUSES = ['NEW', 'ASSIGNED', 'SETTLED', 'IGNORED'] as const;
export type BankTxStatus = (typeof BANK_TX_STATUSES)[number];

export const DEST_REF_KINDS = ['account', 'card', 'iban'] as const;
export type DestRefKind = (typeof DEST_REF_KINDS)[number];

export interface BankTransaction {
  id: string;
  bankKey: string;
  amountRial: number;
  destRef: string;
  destRefKind: DestRefKind;
  cardId: string | null;
  balanceRial: number | null;
  sourceRef: string;
  reference: string;
  occurredAt: string;
  status: BankTxStatus;
  sessionId: string | null;
  enteredBy: string;
  note: string;
  rawText: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewBankTransaction {
  bankKey?: string;
  amountRial: number;
  destRef?: string;
  destRefKind?: DestRefKind;
  cardId?: string | null;
  balanceRial?: number | null;
  sourceRef?: string;
  reference?: string;
  occurredAt?: string;
  enteredBy?: string;
  note?: string;
  rawText?: string;
}

export class TransactionError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'TransactionError'; }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
export async function ensureTransactionSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id TEXT PRIMARY KEY,
      bank_key TEXT NOT NULL DEFAULT '',
      amount_rial BIGINT NOT NULL,
      dest_ref TEXT NOT NULL DEFAULT '',
      dest_ref_kind TEXT NOT NULL DEFAULT 'account',
      card_id TEXT REFERENCES c2c_cards(id),
      balance_rial BIGINT,
      source_ref TEXT NOT NULL DEFAULT '',
      reference TEXT NOT NULL DEFAULT '',
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'NEW',
      session_id TEXT REFERENCES c2c_sessions(id),
      entered_by TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      raw_text TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS bank_tx_reference_unique
      ON bank_transactions(bank_key, reference) WHERE reference <> '';
    CREATE INDEX IF NOT EXISTS bank_tx_status_time ON bank_transactions(status, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS bank_tx_amount_lookup ON bank_transactions(amount_rial, occurred_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS bank_tx_session_unique
      ON bank_transactions(session_id) WHERE session_id IS NOT NULL;
  `);
  _schemaReady = true;
}

const mem = new Map<string, BankTransaction>();

function rowToTx(r: any): BankTransaction {
  return {
    id: r.id,
    bankKey: r.bank_key ?? '',
    amountRial: Number(r.amount_rial),
    destRef: r.dest_ref ?? '',
    destRefKind: (DEST_REF_KINDS as readonly string[]).includes(r.dest_ref_kind) ? r.dest_ref_kind : 'account',
    cardId: r.card_id ?? null,
    balanceRial: r.balance_rial == null ? null : Number(r.balance_rial),
    sourceRef: r.source_ref ?? '',
    reference: r.reference ?? '',
    occurredAt: r.occurred_at?.toISOString?.() ?? String(r.occurred_at),
    status: (BANK_TX_STATUSES as readonly string[]).includes(r.status) ? r.status : 'NEW',
    sessionId: r.session_id ?? null,
    enteredBy: r.entered_by ?? '',
    note: r.note ?? '',
    rawText: r.raw_text ?? '',
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    updatedAt: r.updated_at?.toISOString?.() ?? String(r.updated_at)
  };
}

export async function insertTransaction(input: NewBankTransaction): Promise<BankTransaction> {
  const now = new Date().toISOString();
  const tx: BankTransaction = {
    id: id(),
    bankKey: (input.bankKey ?? '').trim(),
    amountRial: Math.floor(Number(input.amountRial)),
    destRef: (input.destRef ?? '').trim(),
    destRefKind: input.destRefKind ?? 'account',
    cardId: input.cardId ?? null,
    balanceRial: input.balanceRial == null ? null : Math.floor(Number(input.balanceRial)),
    sourceRef: (input.sourceRef ?? '').trim(),
    reference: (input.reference ?? '').trim(),
    occurredAt: input.occurredAt ?? now,
    status: 'NEW',
    sessionId: null,
    enteredBy: input.enteredBy ?? '',
    note: input.note ?? '',
    rawText: input.rawText ?? '',
    createdAt: now,
    updatedAt: now
  };
  const pool = pg();
  if (pool) {
    await ensureTransactionSchema(pool);
    try {
      const { rows } = await pool.query(
        `INSERT INTO bank_transactions(id,bank_key,amount_rial,dest_ref,dest_ref_kind,card_id,balance_rial,
           source_ref,reference,occurred_at,status,entered_by,note,raw_text,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING *`,
        [tx.id, tx.bankKey, tx.amountRial, tx.destRef, tx.destRefKind, tx.cardId, tx.balanceRial,
         tx.sourceRef, tx.reference, tx.occurredAt, tx.status, tx.enteredBy, tx.note, tx.rawText, now]);
      return rowToTx(rows[0]);
    } catch (e) {
      /* The bank's own reference, when a bank gives one, is the second defence
       * against the same deposit being entered twice. */
      if ((e as { code?: string }).code === '23505') {
        throw new TransactionError('BANK_TX_DUPLICATE', 'این تراکنش با همین کد پیگیری قبلاً ثبت شده است.');
      }
      throw e;
    }
  }
  if (tx.reference && [...mem.values()].some((t) => t.bankKey === tx.bankKey && t.reference === tx.reference)) {
    throw new TransactionError('BANK_TX_DUPLICATE', 'این تراکنش با همین کد پیگیری قبلاً ثبت شده است.');
  }
  mem.set(tx.id, tx);
  return { ...tx };
}

export async function getTransaction(txId: string): Promise<BankTransaction | null> {
  const pool = pg();
  if (pool) {
    await ensureTransactionSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM bank_transactions WHERE id=$1`, [txId]);
    return rows[0] ? rowToTx(rows[0]) : null;
  }
  const t = mem.get(txId);
  return t ? { ...t } : null;
}

export interface TxFilter {
  status?: BankTxStatus;
  from?: string;
  to?: string;
  amountRial?: number;
  limit?: number;
}

export async function listTransactions(filter: TxFilter = {}): Promise<BankTransaction[]> {
  const limit = Math.max(1, Math.min(500, Number(filter.limit ?? 100)));
  const pool = pg();
  if (pool) {
    await ensureTransactionSchema(pool);
    const where: string[] = []; const params: any[] = [];
    if (filter.status) { params.push(filter.status); where.push(`status=$${params.length}`); }
    if (filter.from) { params.push(filter.from); where.push(`occurred_at >= $${params.length}`); }
    if (filter.to) { params.push(filter.to); where.push(`occurred_at <= $${params.length}`); }
    if (filter.amountRial) { params.push(filter.amountRial); where.push(`amount_rial=$${params.length}`); }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT * FROM bank_transactions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY occurred_at DESC, created_at DESC LIMIT $${params.length}`, params);
    return rows.map(rowToTx);
  }
  return [...mem.values()]
    .filter((t) => (!filter.status || t.status === filter.status)
      && (!filter.from || t.occurredAt >= filter.from)
      && (!filter.to || t.occurredAt <= filter.to)
      && (!filter.amountRial || t.amountRial === filter.amountRial))
    .sort((a, b) => (a.occurredAt > b.occurredAt ? -1 : a.occurredAt < b.occurredAt ? 1 : 0))
    .slice(0, limit);
}

/**
 * Bind a transaction to a session — the step that decides whose money this is.
 *
 * Conditional on the transaction still being unbound, so two operators looking
 * at the same queue cannot both assign it: exactly one UPDATE matches and the
 * other is told the row moved on. The `session_id` unique index is the second
 * half of that, and the one that survives a bug here.
 */
export async function bindToSession(txId: string, sessionId: string): Promise<BankTransaction | null> {
  const now = new Date().toISOString();
  const pool = pg();
  if (pool) {
    await ensureTransactionSchema(pool);
    try {
      const { rows } = await pool.query(
        `UPDATE bank_transactions SET session_id=$2, status='ASSIGNED', updated_at=$3
          WHERE id=$1 AND status='NEW' AND session_id IS NULL RETURNING *`, [txId, sessionId, now]);
      return rows[0] ? rowToTx(rows[0]) : null;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new TransactionError('SESSION_ALREADY_PAID', 'این پرداخت قبلاً با تراکنش دیگری تسویه شده است.');
      }
      throw e;
    }
  }
  const t = mem.get(txId);
  if (!t || t.status !== 'NEW' || t.sessionId) return null;
  if ([...mem.values()].some((x) => x.sessionId === sessionId)) {
    throw new TransactionError('SESSION_ALREADY_PAID', 'این پرداخت قبلاً با تراکنش دیگری تسویه شده است.');
  }
  t.sessionId = sessionId; t.status = 'ASSIGNED'; t.updatedAt = now;
  return { ...t };
}

/** Only ever forward: ASSIGNED → SETTLED, or NEW → IGNORED. */
export async function setTransactionStatus(txId: string, status: BankTxStatus, note?: string): Promise<BankTransaction | null> {
  const now = new Date().toISOString();
  const pool = pg();
  if (pool) {
    await ensureTransactionSchema(pool);
    const { rows } = await pool.query(
      `UPDATE bank_transactions SET status=$2, note=COALESCE($3, note), updated_at=$4 WHERE id=$1 RETURNING *`,
      [txId, status, note ?? null, now]);
    return rows[0] ? rowToTx(rows[0]) : null;
  }
  const t = mem.get(txId);
  if (!t) return null;
  t.status = status; if (note != null) t.note = note; t.updatedAt = now;
  return { ...t };
}

/** How much really arrived, for the day's reconciliation. */
export async function settledTotalRial(from?: string, to?: string): Promise<{ count: number; totalRial: number }> {
  const rows = (await listTransactions({ status: 'SETTLED', from, to, limit: 500 }));
  return { count: rows.length, totalRial: rows.reduce((s, r) => s + r.amountRial, 0) };
}

/** Test seam. */
export function _resetTransactions(): void { mem.clear(); _schemaReady = false; }
