/* A CLEAN SLATE FOR THE CARD-TO-CARD TABLES.
 *
 * Four suites need this and each one grew its own copy, which is how the last
 * one broke: `bank_transactions` references `c2c_sessions`, so a reset written
 * before that table existed deletes the sessions first and hits a foreign key.
 * One place to get the order right means the next table added to this chain
 * breaks nothing.
 *
 * Deletion order is child-before-parent, and the memory driver is reset
 * through each store's own seam — which also clears the `_schemaReady` flags,
 * so a suite that switches drivers mid-run still builds its schema.
 */
import { listCards, removeCard, _resetCards } from '../services/c2c/cardService.js';
import { _resetSessions } from '../services/c2c/sessionStore.js';
import { _resetTransactions } from '../services/c2c/transactionStore.js';

export async function resetC2c(): Promise<void> {
  if (process.env.DATABASE_URL) {
    const { getPgPool } = await import('../database/postgres.js');
    const pool = getPgPool();
    /* Children first: bank_transactions → c2c_sessions → c2c_cards. */
    for (const table of ['bank_transactions', 'c2c_sessions', 'c2c_cards']) {
      await pool.query(`DELETE FROM ${table}`).catch(() => undefined);
    }
  }
  /* The memory driver keeps cards in a map the PG delete above never touches. */
  for (const c of await listCards().catch(() => [])) await removeCard(c.id).catch(() => undefined);
  _resetTransactions();
  _resetSessions();
  _resetCards();
}
