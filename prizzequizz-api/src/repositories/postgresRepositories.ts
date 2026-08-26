import { getPgPool } from '../database/postgres.js';
import { logger } from '../services/logger.js';
import type { RepositoryBundle, RewardRecord } from './contracts.js';
import type { AnswerSubmission, BetaAccess, BetaInvite, BetaInviteStatus, CharacterInventory, CharacterItem, CharacterItemStatus, CharacterUnlockEvent, DeviceRecord, DeviceTrustStatus, ErrorReport, ErrorReportStatus, IntegritySignal, IntegrityStatus, Match, MatchEvent, NotificationPreferences, NotificationRecord, PaymentIntent, PaymentIntentStatus, PushSubscriptionRecord, Question, RewardHold, RewardHoldStatus, SupportMessage, SupportTicket, SupportTicketStatus, Transaction, User, UserDeviceBinding, UserRiskProfile } from '../types/domain.js';

const pool = () => getPgPool();

/* Postgres UUID columns reject '' and non-UUID strings (e.g. 'system', 'u1').
 * Coerce anything that isn't a valid UUID to NULL so optional/service ids never
 * blow up an insert. */
function uuidOrNull(v: unknown): string | null {
  const s = String(v ?? '');
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s) ? s : null;
}

import { looksLikePhone, phoneKey } from '../utils/phone.js';

function userFromRow(r: any): User {
  return { id: r.id, phone: r.phone, username: r.username, displayName: r.display_name, gender: r.gender ?? undefined, plan: r.plan, role: r.role ?? 'user', status: r.status ?? 'active', banReason: r.ban_reason ?? undefined, bannedAt: r.banned_at?.toISOString?.() ?? r.banned_at ?? undefined, level: r.level, xp: Number(r.xp), weeklyScore: Number(r.weekly_score ?? 0), weeklyWeek: r.weekly_week ?? undefined, wallet: Number(r.wallet_balance), coins: Number(r.coins), hearts: Number(r.hearts), tickets: r.tickets ?? { bronze: 0, silver: 0, gold: 0 }, lifelines: r.lifelines ?? undefined };
}

function questionFromRow(r: any): Question {
  return { id: r.id, text: r.text, options: r.options, correctIndex: r.correct_index, category: r.category, difficulty: r.difficulty, tags: r.tags ?? [], status: r.status, version: r.version };
}

function matchFromRow(r: any, players: any[] = []): Match {
  return { id: r.id, modeId: r.mode_id, economyType: r.economy_type, phase: r.status, round: r.current_round, winnerUserId: r.winner_user_id ?? undefined, configVersion: r.config_version, players: players.map((p) => ({ userId: p.user_id, username: p.username ?? 'Player', avatar: p.avatar ?? '👤', score: p.score, correctAnswers: p.correct_answers, wrongAnswers: p.wrong_answers, eliminated: p.eliminated })), createdAt: r.created_at?.toISOString?.() ?? r.created_at, updatedAt: r.updated_at?.toISOString?.() ?? r.updated_at };
}


/* COLUMNS ADDED AFTER THE FIRST DEPLOY.
 *
 * Migrations are applied by `npm run migrate`, which reads .sql files from the
 * working directory — and the deployed bundle is compiled JavaScript with no
 * database/migrations folder in it. So a release that starts writing a NEW
 * column will fail EVERY user save on a server whose migration was not run by
 * hand: XP awards, coin spends, profile edits, all of it.
 *
 * The column adds itself, the same way every new table in this codebase does.
 * If it cannot (no rights), saves fall back to the statement without it rather
 * than failing — a missing gender is a blank field; a failing save is the game.
 */
let _genderColumn: 'unknown' | 'yes' | 'no' = 'unknown';
async function ensureGenderColumn(): Promise<boolean> {
  if (_genderColumn !== 'unknown') return _genderColumn === 'yes';
  try {
    await pool().query('ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(12)');
    _genderColumn = 'yes';
  } catch (e) {
    _genderColumn = 'no';
    logger.warn('users_gender_column_unavailable', { message: e instanceof Error ? e.message : 'unknown' });
  }
  return _genderColumn === 'yes';
}

export const postgresRepositories: RepositoryBundle = {
  beta: {
    async saveInvite(i: BetaInvite): Promise<void> { await pool().query(`insert into beta_invites(code,max_uses,used_count,status,note,created_by,created_at,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(code) do update set max_uses=$2, used_count=$3, status=$4, note=$5, expires_at=$8`, [i.code.toUpperCase(),i.maxUses,i.usedCount,i.status,i.note??null,i.createdBy === 'system' ? null : i.createdBy,i.createdAt,i.expiresAt??null]); },
    async findInvite(code: string): Promise<BetaInvite | null> { const { rows } = await pool().query('select * from beta_invites where code=$1', [code.toUpperCase()]); return rows[0] ? betaInviteFromRow(rows[0]) : null; },
    async listInvites(limit = 100): Promise<BetaInvite[]> { const { rows } = await pool().query('select * from beta_invites order by created_at desc limit $1', [limit]); return rows.map(betaInviteFromRow); },
    async updateInviteStatus(code: string, status: BetaInviteStatus): Promise<BetaInvite | null> { const { rows } = await pool().query('update beta_invites set status=$2 where code=$1 returning *', [code.toUpperCase(), status]); return rows[0] ? betaInviteFromRow(rows[0]) : null; },
    async saveAccess(a: BetaAccess): Promise<void> { await pool().query(`insert into beta_access(user_id,invite_code,granted_at,granted_by) values($1,$2,$3,$4) on conflict(user_id) do update set invite_code=$2, granted_at=$3, granted_by=$4`, [a.userId,a.inviteCode.toUpperCase(),a.grantedAt,a.grantedBy === 'system' ? null : a.grantedBy]); },
    async findAccess(userId: string): Promise<BetaAccess | null> { const { rows } = await pool().query('select * from beta_access where user_id=$1', [userId]); return rows[0] ? betaAccessFromRow(rows[0]) : null; },
    async listAccess(limit = 100): Promise<BetaAccess[]> { const { rows } = await pool().query('select * from beta_access order by granted_at desc limit $1', [limit]); return rows.map(betaAccessFromRow); }
  },
  characters: {
    async listItems(status?: CharacterItemStatus): Promise<CharacterItem[]> { const { rows } = status ? await pool().query('select * from character_items where status=$1 order by slot,title', [status]) : await pool().query('select * from character_items order by slot,title'); return rows.map(characterItemFromRow); },
    async findItemById(id: string): Promise<CharacterItem | null> { const { rows } = await pool().query('select * from character_items where id=$1', [id]); return rows[0] ? characterItemFromRow(rows[0]) : null; },
    async saveItem(item: CharacterItem): Promise<void> { await pool().query(`insert into character_items(id,slot,title,src,rarity,price_coins,unlock_level,tags,status,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(id) do update set slot=$2,title=$3,src=$4,rarity=$5,price_coins=$6,unlock_level=$7,tags=$8,status=$9,updated_at=$11`, [item.id,item.slot,item.title,item.src,item.rarity,item.priceCoins,item.unlockLevel??1,item.tags,item.status,item.createdAt,item.updatedAt]); },
    async updateItemStatus(id: string, status: CharacterItemStatus): Promise<CharacterItem | null> { const { rows } = await pool().query('update character_items set status=$2, updated_at=now() where id=$1 returning *', [id,status]); return rows[0] ? characterItemFromRow(rows[0]) : null; },
    async getInventory(userId: string): Promise<CharacterInventory | null> { const { rows } = await pool().query('select * from user_character_inventory where user_id=$1', [userId]); return rows[0] ? characterInventoryFromRow(rows[0]) : null; },
    async saveInventory(inv: CharacterInventory): Promise<void> { await pool().query(`insert into user_character_inventory(user_id,unlocked_item_ids,loadout,updated_at) values($1,$2,$3,$4) on conflict(user_id) do update set unlocked_item_ids=$2, loadout=$3, updated_at=$4`, [inv.userId, inv.unlockedItemIds, JSON.stringify(inv.loadout), inv.updatedAt]); },
    async appendUnlockEvent(event: CharacterUnlockEvent): Promise<void> { await pool().query('insert into character_unlock_events(id,user_id,item_id,reason,created_at) values($1,$2,$3,$4,$5) on conflict(id) do nothing', [event.id,event.userId,event.itemId,event.reason,event.createdAt]); },
    async listUnlockEvents(userId: string, limit = 100): Promise<CharacterUnlockEvent[]> { const { rows } = await pool().query('select * from character_unlock_events where user_id=$1 order by created_at desc limit $2', [userId, limit]); return rows.map(characterUnlockEventFromRow); }
  },
  users: {
    /* users.id is a UUID column, so an id that is not UUID text makes Postgres
     * raise a cast error (22P02) instead of returning no rows — and that error
     * travelled up as a 500. An id that cannot be a UUID cannot match any row,
     * so the truthful answer is "no such user". Only 22P02 is swallowed: a real
     * outage must still surface rather than read as a missing account. */
    async findById(id: string): Promise<User | null> {
      try {
        const { rows } = await pool().query('select * from users where id=$1', [id]);
        return rows[0] ? userFromRow(rows[0]) : null;
      } catch (e) {
        if ((e as { code?: string })?.code === '22P02') return null;
        throw e;
      }
    },
    async findByPhone(phone: string): Promise<User | null> { const { rows } = await pool().query('select * from users where phone=$1', [phone]); return rows[0] ? userFromRow(rows[0]) : null; },
    async list(limit = 1000): Promise<User[]> { const { rows } = await pool().query('select * from users order by updated_at desc limit $1', [limit]); return rows.map(userFromRow); },
    /* SEARCHED IN SQL, ACROSS THE WHOLE TABLE.
       It used to be `list(200)` filtered in memory, which searches the two
       hundred most recently ACTIVE accounts — the opposite of who a support
       case is usually about. Somebody who last played in March could not be
       found by any spelling of their name.
       The phone column is compared with its punctuation stripped, against the
       last ten digits of what was typed, so +98912…, 0912… and ۰۹۱۲… are one
       number. */
    async search(query: string, limit = 200): Promise<User[]> {
      /* `id` is a uuid column, so it has to be cast before ILIKE will look at
         it — without the cast Postgres refuses the whole statement and every
         search in the panel throws. The memory driver cannot show that. */
      const q = String(query ?? '').trim();
      if (!q) return this.list(limit);
      const like = '%' + q.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
      const key = looksLikePhone(q) ? phoneKey(q) : '';
      const { rows } = await pool().query(
        `select * from users
          where id::text ilike $1 or username ilike $1 or display_name ilike $1 or phone ilike $1
             or ($2 <> '' and regexp_replace(coalesce(phone,''), '\\D', '', 'g') like '%' || $2)
          order by updated_at desc limit $3`,
        [like, key, Math.min(1000, Math.max(1, limit))]
      );
      return rows.map(userFromRow);
    },
    async save(user: User): Promise<void> {
      const values = [user.id,user.phone,user.username,user.displayName,user.plan,user.coins,user.hearts,user.wallet,user.xp,user.level,user.weeklyScore,user.role ?? 'user',user.status ?? 'active',user.banReason ?? null,user.bannedAt ?? null];
      if (await ensureGenderColumn()) {
        await pool().query(`insert into users(id,phone,username,display_name,plan,coins,hearts,wallet_balance,xp,level,weekly_score,role,status,ban_reason,banned_at,gender,updated_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
          on conflict(id) do update set phone=$2, username=$3, display_name=$4, plan=$5, coins=$6, hearts=$7, wallet_balance=$8, xp=$9, level=$10, weekly_score=$11, role=$12, status=$13, ban_reason=$14, banned_at=$15, gender=$16, updated_at=now()`,
          [...values, user.gender ?? null]);
        return;
      }
      await pool().query(`insert into users(id,phone,username,display_name,plan,coins,hearts,wallet_balance,xp,level,weekly_score,role,status,ban_reason,banned_at,updated_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
        on conflict(id) do update set phone=$2, username=$3, display_name=$4, plan=$5, coins=$6, hearts=$7, wallet_balance=$8, xp=$9, level=$10, weekly_score=$11, role=$12, status=$13, ban_reason=$14, banned_at=$15, updated_at=now()`,
        values);
    },
    async remove(id: string): Promise<void> { await pool().query('delete from users where id=$1', [id]); },
    async updateLifelines(userId: string, lifelines: Record<string, number>): Promise<void> {
      await pool().query('update users set lifelines=$1, updated_at=now() where id=$2', [JSON.stringify(lifelines), userId]);
    }
  },
  questions: {
    async findById(id: string): Promise<Question | null> { const { rows } = await pool().query('select * from questions where id=$1', [id]); return rows[0] ? questionFromRow(rows[0]) : null; },
    async listApproved(): Promise<Question[]> { const { rows } = await pool().query("select * from questions where status='approved' order by created_at asc limit 100000"); return rows.map(questionFromRow); },
    async listAll(status?: string): Promise<Question[]> { const { rows } = status ? await pool().query('select * from questions where status=$1 order by created_at desc limit 100000',[status]) : await pool().query('select * from questions order by created_at desc limit 100000'); return rows.map(questionFromRow); },
    async save(q: Question): Promise<void> { await pool().query(`insert into questions(id,text,options,correct_index,category,difficulty,tags,status,version) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(id) do update set text=$2, options=$3, correct_index=$4, category=$5, difficulty=$6, tags=$7, status=$8, version=$9`, [q.id,q.text,JSON.stringify(q.options),q.correctIndex,q.category,q.difficulty,q.tags,q.status,q.version]); },
    async remove(id: string): Promise<void> { await pool().query('delete from questions where id=$1', [id]); }
  },
  matches: {
    async findById(id: string): Promise<Match | null> { const m = await pool().query('select * from matches where id=$1', [id]); if (!m.rows[0]) return null; const players = await pool().query('select mp.*, u.username from match_players mp left join users u on u.id=mp.user_id where match_id=$1', [id]); return matchFromRow(m.rows[0], players.rows); },
    async save(match: Match): Promise<void> {
      await pool().query(`insert into matches(id,mode_id,economy_type,status,current_round,winner_user_id,config_version,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(id) do update set status=$4,current_round=$5,winner_user_id=$6,updated_at=$9`, [match.id,match.modeId,match.economyType,match.phase,match.round,match.winnerUserId ?? null,match.configVersion,match.createdAt,match.updatedAt]);
      for (const p of match.players) {
        await pool().query(`insert into users(id,phone,username,display_name,plan) values($1,$2,$3,$4,'free') on conflict(id) do nothing`, [p.userId, `mock-${p.userId}`, p.username, p.username]);
        await pool().query(`insert into match_players(match_id,user_id,score,correct_answers,wrong_answers,eliminated) values($1,$2,$3,$4,$5,$6) on conflict(match_id,user_id) do update set score=$3, correct_answers=$4, wrong_answers=$5, eliminated=$6`, [match.id,p.userId,p.score,p.correctAnswers,p.wrongAnswers,!!p.eliminated]);
      }
    }
  },
  answers: {
    async findByIdempotencyKey(key: string): Promise<AnswerSubmission | null> { const { rows } = await pool().query('select * from answers where idempotency_key=$1', [key]); const r=rows[0]; return r ? answerFromRow(r) : null; },
    async listByMatch(matchId: string): Promise<AnswerSubmission[]> { const { rows } = await pool().query('select * from answers where match_id=$1 order by created_at asc', [matchId]); return rows.map(answerFromRow); },
    async listByUser(userId: string, limit = 100): Promise<AnswerSubmission[]> { const { rows } = await pool().query('select * from answers where user_id=$1 order by created_at desc limit $2', [userId, limit]); return rows.map(answerFromRow); },
    async save(a: AnswerSubmission): Promise<void> { await pool().query(`insert into answers(id,match_id,user_id,question_id,selected_index,correct,answer_time_ms,idempotency_key,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(idempotency_key) do nothing`, [a.id,a.matchId,a.userId,a.questionId,a.selectedIndex,a.correct,a.answerTimeMs,a.idempotencyKey,a.createdAt]); }
  },
  rewards: {
    async findByIdempotencyKey(key: string): Promise<RewardRecord | null> { const { rows } = await pool().query('select * from rewards where idempotency_key=$1', [key]); const r=rows[0]; return r ? { id:r.id, userId:r.user_id, matchId:r.match_id, type:r.type, amount:Number(r.amount), status:r.status, idempotencyKey:r.idempotency_key } : null; },
    async save(r: RewardRecord): Promise<void> { await pool().query(`insert into rewards(id,user_id,match_id,type,amount,status,reason,idempotency_key,settled_at) values($1,$2,$3,$4,$5,$6::varchar,'match_result',$7,case when $6::varchar='granted' then now() else null end) on conflict(idempotency_key) do update set status=$6::varchar, settled_at=case when $6::varchar='granted' then now() else rewards.settled_at end`, [r.id,r.userId,r.matchId,r.type,r.amount,r.status ?? 'granted',r.idempotencyKey]); }
  },
  rewardHolds: {
    async save(h: RewardHold): Promise<void> { await pool().query(`insert into reward_holds(id,reward_id,user_id,match_id,reward_type,amount,status,risk_score,risk_level,reason,evidence,idempotency_key,created_at,reviewed_at,reviewed_by,released_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) on conflict(id) do update set status=$7, reviewed_at=$14, reviewed_by=$15, released_at=$16`, [h.id,h.rewardId,h.userId,h.matchId,h.rewardType,h.amount,h.status,h.riskScore,h.riskLevel,h.reason,JSON.stringify(h.evidence),h.idempotencyKey,h.createdAt,h.reviewedAt??null,uuidOrNull(h.reviewedBy),h.releasedAt??null]); },
    async findById(id: string): Promise<RewardHold | null> { const { rows } = await pool().query('select * from reward_holds where id=$1', [id]); return rows[0] ? rewardHoldFromRow(rows[0]) : null; },
    async findByIdempotencyKey(idempotencyKey: string): Promise<RewardHold | null> { const { rows } = await pool().query('select * from reward_holds where idempotency_key=$1', [idempotencyKey]); return rows[0] ? rewardHoldFromRow(rows[0]) : null; },
    async list(filter = {}): Promise<RewardHold[]> { const clauses:string[]=[]; const values:any[]=[]; const add=(sql:string,value:any)=>{ values.push(value); clauses.push(sql.replace('?', '$'+values.length)); }; if ((filter as any).userId) add('user_id=?',(filter as any).userId); if ((filter as any).matchId) add('match_id=?',(filter as any).matchId); if ((filter as any).status) add('status=?',(filter as any).status); values.push(Math.min(500, Math.max(1, Number((filter as any).limit ?? 100)))); const where=clauses.length?'where '+clauses.join(' and '):''; const { rows } = await pool().query(`select * from reward_holds ${where} order by created_at desc limit $${values.length}`, values); return rows.map(rewardHoldFromRow); },
    async updateStatus(id: string, status: RewardHoldStatus, reviewedBy: string, extra: Partial<RewardHold> = {}): Promise<RewardHold | null> { const { rows } = await pool().query('update reward_holds set status=$2, reviewed_by=$3, reviewed_at=now(), released_at=coalesce($4,released_at) where id=$1 returning *', [id,status,uuidOrNull(reviewedBy),extra.releasedAt??null]); return rows[0] ? rewardHoldFromRow(rows[0]) : null; }
  },
  support: {
    async saveTicket(t: SupportTicket): Promise<void> { await pool().query(`insert into support_tickets(id,user_id,title,category,body,status,priority,reply,linked_match_id,linked_transaction_id,linked_reward_hold_id,assigned_admin_id,created_at,updated_at,closed_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict(id) do update set title=$3,category=$4,body=$5,status=$6,priority=$7,reply=$8,linked_match_id=$9,linked_transaction_id=$10,linked_reward_hold_id=$11,assigned_admin_id=$12,updated_at=$14,closed_at=$15`, [t.id,t.userId,t.title,t.category,t.body,t.status,t.priority,t.reply??null,t.linkedMatchId||null,t.linkedTransactionId||null,t.linkedRewardHoldId||null,uuidOrNull(t.assignedAdminId),t.createdAt,t.updatedAt,t.closedAt??null]); },
    async findTicketById(id: string): Promise<SupportTicket | null> { const { rows } = await pool().query('select * from support_tickets where id=$1', [id]); return rows[0] ? supportTicketFromRow(rows[0]) : null; },
    async listTickets(filter = {}): Promise<SupportTicket[]> { const f=filter as any; const clauses:string[]=[]; const values:any[]=[]; const add=(sql:string,value:any)=>{values.push(value);clauses.push(sql.replace('?', '$'+values.length));}; if(f.userId)add('user_id=?',f.userId); if(f.status)add('status=?',f.status); if(f.category)add('category=?',f.category); if(f.priority)add('priority=?',f.priority); if(f.assignedAdminId)add('assigned_admin_id=?',f.assignedAdminId); values.push(Math.min(500,Math.max(1,Number(f.limit??100)))); const where=clauses.length?'where '+clauses.join(' and '):''; const { rows }=await pool().query(`select * from support_tickets ${where} order by updated_at desc limit $${values.length}`,values); return rows.map(supportTicketFromRow); },
    async updateTicket(id: string, patch: Partial<SupportTicket>): Promise<SupportTicket | null> { const current = await this.findTicketById(id); if (!current) return null; const next = { ...current, ...patch, updatedAt: new Date().toISOString() } as SupportTicket; await this.saveTicket(next); return next; },
    async appendMessage(m: SupportMessage): Promise<void> { await pool().query('insert into support_messages(id,ticket_id,sender_id,sender_role,body,created_at) values($1,$2,$3,$4,$5,$6)', [m.id,m.ticketId,m.senderId,m.senderRole,m.body,m.createdAt]); },
    async listMessages(ticketId: string): Promise<SupportMessage[]> { const { rows } = await pool().query('select * from support_messages where ticket_id=$1 order by created_at asc', [ticketId]); return rows.map(supportMessageFromRow); }
  },
  transactions: {
    async findById(id: string): Promise<Transaction | null> { const { rows } = await pool().query('select * from transactions where id=$1', [id]); return rows[0] ? transactionFromRow(rows[0]) : null; },
    async list(filter = {}): Promise<Transaction[]> { const f = filter as any; const clauses:string[]=[]; const values:any[]=[]; const add=(sql:string,value:any)=>{ values.push(value); clauses.push(sql.replace('?', '$'+values.length)); }; if (f.userId) add('user_id=?', f.userId); if (f.type) add('type=?', f.type); if (f.direction) add('direction=?', f.direction); if (f.status) add('status=?', f.status); if (f.currency) add('currency=?', f.currency); values.push(Math.min(1000, Math.max(1, Number(f.limit ?? 100)))); const where=clauses.length?'where '+clauses.join(' and '):''; const { rows } = await pool().query(`select * from transactions ${where} order by created_at desc limit $${values.length}`, values); return rows.map(transactionFromRow); },
    async listByUser(userId: string): Promise<Transaction[]> { const { rows } = await pool().query('select * from transactions where user_id=$1 order by created_at desc limit 100', [userId]); return rows.map(transactionFromRow); },
    async listWinnings(limit = 100): Promise<{ userId: string; score: number }[]> { const { rows } = await pool().query(`select user_id, coalesce(sum(amount),0) as score from transactions where direction='in' and status <> 'failed' and type in ('reward','win') and currency in ('cash','coins') group by user_id order by score desc limit $1`, [limit]); return rows.map((r:any)=>({ userId:r.user_id, score:Number(r.score) })); },
    /* Same money, windowed to this week. date_trunc('week') is Monday-based, the
       same boundary the weekly cup resets on, so the two always turn over together. */
    async listWeeklyWinnings(limit = 100): Promise<{ userId: string; score: number }[]> { const { rows } = await pool().query(`select user_id, coalesce(sum(amount),0) as score from transactions where direction='in' and status <> 'failed' and type in ('reward','win') and currency in ('cash','coins') and created_at >= date_trunc('week', now()) group by user_id order by score desc limit $1`, [limit]); return rows.map((r:any)=>({ userId:r.user_id, score:Number(r.score) })); },
    async save(t: Transaction): Promise<void> { await pool().query(`insert into transactions(id,user_id,type,currency,amount,direction,status,reference,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(id) do update set status=$7, reference=$8`, [t.id,t.userId,t.type,t.currency,t.amount,t.direction,t.status,t.reference,t.createdAt]); },
    async updateStatus(id: string, status: Transaction['status'], reference?: string): Promise<Transaction | null> { const { rows } = await pool().query('update transactions set status=$2, reference=coalesce($3,reference) where id=$1 returning *', [id,status,reference??null]); return rows[0] ? transactionFromRow(rows[0]) : null; }
  },
  matchEvents: {
    async append(e: MatchEvent): Promise<void> { await pool().query('insert into match_events(id,match_id,event_type,payload,created_at) values($1,$2,$3,$4,$5)', [e.id,e.matchId,e.type,JSON.stringify(e.payload),e.createdAt]); },
    async listByMatch(matchId: string): Promise<MatchEvent[]> { const { rows } = await pool().query('select * from match_events where match_id=$1 order by created_at asc', [matchId]); return rows.map((r:any)=>({ id:r.id, matchId:r.match_id, type:r.event_type, payload:r.payload, createdAt:r.created_at.toISOString() })); }
  },
  devices: {
    async findById(id: string): Promise<DeviceRecord | null> { const { rows } = await pool().query('select * from devices where id=$1', [id]); return rows[0] ? deviceFromRow(rows[0]) : null; },
    async findByFingerprintHash(fingerprintHash: string): Promise<DeviceRecord | null> { const { rows } = await pool().query('select * from devices where fingerprint_hash=$1', [fingerprintHash]); return rows[0] ? deviceFromRow(rows[0]) : null; },
    async saveDevice(d: DeviceRecord): Promise<void> { await pool().query(`insert into devices(id,fingerprint_hash,client_device_id,user_agent,platform,first_ip_address,last_ip_address,first_seen_at,last_seen_at,trust_status,revoked_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(id) do update set client_device_id=$3,user_agent=$4,platform=$5,last_ip_address=$7,last_seen_at=$9,trust_status=$10,revoked_at=$11`, [d.id,d.fingerprintHash,d.clientDeviceId??null,d.userAgent??null,d.platform??null,d.firstIpAddress??null,d.lastIpAddress??null,d.firstSeenAt,d.lastSeenAt,d.trustStatus,d.revokedAt??null]); },
    async listDevices(limit = 500): Promise<DeviceRecord[]> { const { rows } = await pool().query('select * from devices order by last_seen_at desc limit $1', [limit]); return rows.map(deviceFromRow); },
    async findBinding(userId: string, deviceId: string): Promise<UserDeviceBinding | null> { const { rows } = await pool().query('select * from user_device_bindings where user_id=$1 and device_id=$2', [userId, deviceId]); return rows[0] ? bindingFromRow(rows[0]) : null; },
    async saveBinding(b: UserDeviceBinding): Promise<void> { await pool().query(`insert into user_device_bindings(id,user_id,device_id,first_seen_at,last_seen_at,last_ip_address,trust_status,risk_score) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(user_id,device_id) do update set last_seen_at=$5,last_ip_address=$6,trust_status=$7,risk_score=$8`, [b.id,b.userId,b.deviceId,b.firstSeenAt,b.lastSeenAt,b.lastIpAddress??null,b.trustStatus,b.riskScore]); },
    async listBindingsByUser(userId: string): Promise<UserDeviceBinding[]> { const { rows } = await pool().query('select * from user_device_bindings where user_id=$1 order by last_seen_at desc', [userId]); return rows.map(bindingFromRow); },
    async listBindingsByDevice(deviceId: string): Promise<UserDeviceBinding[]> { const { rows } = await pool().query('select * from user_device_bindings where device_id=$1 order by last_seen_at desc', [deviceId]); return rows.map(bindingFromRow); },
    async updateBindingStatus(bindingId: string, status: DeviceTrustStatus): Promise<UserDeviceBinding | null> { const { rows } = await pool().query('update user_device_bindings set trust_status=$2,last_seen_at=now() where id=$1 returning *', [bindingId,status]); return rows[0] ? bindingFromRow(rows[0]) : null; },
    async getRiskProfile(userId: string): Promise<UserRiskProfile | null> { const { rows } = await pool().query('select * from user_risk_profiles where user_id=$1', [userId]); return rows[0] ? riskProfileFromRow(rows[0]) : null; },
    async saveRiskProfile(p: UserRiskProfile): Promise<void> { await pool().query(`insert into user_risk_profiles(user_id,risk_score,risk_level,reasons,device_count,shared_device_count,integrity_signal_count,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(user_id) do update set risk_score=$2,risk_level=$3,reasons=$4,device_count=$5,shared_device_count=$6,integrity_signal_count=$7,updated_at=$8`, [p.userId,p.riskScore,p.riskLevel,p.reasons,p.deviceCount,p.sharedDeviceCount,p.integritySignalCount,p.updatedAt]); },
    async listRiskProfiles(limit = 100): Promise<UserRiskProfile[]> { const { rows } = await pool().query('select * from user_risk_profiles order by risk_score desc, updated_at desc limit $1', [limit]); return rows.map(riskProfileFromRow); }
  },
  integrity: {
    async save(signal: IntegritySignal): Promise<void> { await pool().query(`insert into integrity_signals(id,match_id,user_id,question_id,type,severity,risk_score,status,evidence,created_at,reviewed_at,reviewed_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(id) do update set status=$8, reviewed_at=$11, reviewed_by=$12`, [signal.id,signal.matchId,signal.userId,signal.questionId??null,signal.type,signal.severity,signal.riskScore,signal.status,JSON.stringify(signal.evidence),signal.createdAt,signal.reviewedAt??null,uuidOrNull(signal.reviewedBy)]); },
    async list(filter = {}): Promise<IntegritySignal[]> { const clauses:string[]=[]; const values:any[]=[]; const add=(sql:string,value:any)=>{ values.push(value); clauses.push(sql.replace('?', '$'+values.length)); }; if ((filter as any).userId) add('user_id=?',(filter as any).userId); if ((filter as any).matchId) add('match_id=?',(filter as any).matchId); if ((filter as any).status) add('status=?',(filter as any).status); if ((filter as any).severity) add('severity=?',(filter as any).severity); values.push(Math.min(500, Math.max(1, Number((filter as any).limit ?? 100)))); const where=clauses.length?'where '+clauses.join(' and '):''; const { rows } = await pool().query(`select * from integrity_signals ${where} order by created_at desc limit $${values.length}`, values); return rows.map(integrityFromRow); },
    async findById(id: string): Promise<IntegritySignal | null> { const { rows } = await pool().query('select * from integrity_signals where id=$1', [id]); return rows[0] ? integrityFromRow(rows[0]) : null; },
    async updateStatus(id: string, status: IntegrityStatus, reviewedBy: string): Promise<IntegritySignal | null> { const { rows } = await pool().query('update integrity_signals set status=$2, reviewed_by=$3, reviewed_at=now() where id=$1 returning *', [id,status,uuidOrNull(reviewedBy)]); return rows[0] ? integrityFromRow(rows[0]) : null; }
  },
  errorReports: {
    async save(r: ErrorReport): Promise<void> { await pool().query(`insert into error_reports(id,user_id,source,severity,status,message,stack,route,user_agent,app_version,build_id,device_id,metadata,created_at,resolved_at,resolved_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) on conflict(id) do update set status=$5,resolved_at=$15,resolved_by=$16`, [r.id,r.userId??null,r.source,r.severity,r.status,r.message,r.stack??null,r.route??null,r.userAgent??null,r.appVersion??null,r.buildId??null,r.deviceId??null,JSON.stringify(r.metadata),r.createdAt,r.resolvedAt??null,uuidOrNull(r.resolvedBy)]); },
    async findById(id: string): Promise<ErrorReport | null> { const { rows } = await pool().query('select * from error_reports where id=$1', [id]); return rows[0] ? errorReportFromRow(rows[0]) : null; },
    async list(filter = {}): Promise<ErrorReport[]> { const f=filter as any; const clauses:string[]=[]; const values:any[]=[]; const add=(sql:string,value:any)=>{values.push(value);clauses.push(sql.replace('?', '$'+values.length));}; if(f.userId)add('user_id=?',f.userId); if(f.status)add('status=?',f.status); if(f.source)add('source=?',f.source); if(f.severity)add('severity=?',f.severity); values.push(Math.min(500,Math.max(1,Number(f.limit??100)))); const where=clauses.length?'where '+clauses.join(' and '):''; const { rows }=await pool().query(`select * from error_reports ${where} order by created_at desc limit $${values.length}`, values); return rows.map(errorReportFromRow); },
    async updateStatus(id: string, status: ErrorReportStatus, resolvedBy: string): Promise<ErrorReport | null> { const { rows } = await pool().query(`update error_reports set status=$2, resolved_by=case when $2 in ('resolved','ignored') then $3 else resolved_by end, resolved_at=case when $2 in ('resolved','ignored') then now() else resolved_at end where id=$1 returning *`, [id,status,uuidOrNull(resolvedBy)]); return rows[0] ? errorReportFromRow(rows[0]) : null; }
  },
  payments: {
    async save(i: PaymentIntent): Promise<void> { await pool().query(`insert into payment_intents(id,user_id,provider,amount,currency,status,transaction_id,payment_url,callback_url,provider_reference,idempotency_key,metadata,created_at,updated_at,paid_at,failed_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) on conflict(id) do update set status=$6, provider_reference=$10, metadata=$12, updated_at=$14, paid_at=$15, failed_at=$16`, [i.id,i.userId,i.provider,i.amount,i.currency,i.status,i.transactionId,i.paymentUrl,i.callbackUrl??null,i.providerReference??null,i.idempotencyKey,JSON.stringify(i.metadata),i.createdAt,i.updatedAt,i.paidAt??null,i.failedAt??null]); },
    async findById(id: string): Promise<PaymentIntent | null> { const { rows } = await pool().query('select * from payment_intents where id=$1', [id]); return rows[0] ? paymentIntentFromRow(rows[0]) : null; },
    async findByIdempotencyKey(key: string): Promise<PaymentIntent | null> { const { rows } = await pool().query('select * from payment_intents where idempotency_key=$1', [key]); return rows[0] ? paymentIntentFromRow(rows[0]) : null; },
    async list(filter = {}): Promise<PaymentIntent[]> { const f=filter as any; const clauses:string[]=[]; const values:any[]=[]; const add=(sql:string,value:any)=>{values.push(value);clauses.push(sql.replace('?', '$'+values.length));}; if(f.userId)add('user_id=?',f.userId); if(f.status)add('status=?',f.status); if(f.provider)add('provider=?',f.provider); values.push(Math.min(500,Math.max(1,Number(f.limit??100)))); const where=clauses.length?'where '+clauses.join(' and '):''; const { rows }=await pool().query(`select * from payment_intents ${where} order by created_at desc limit $${values.length}`, values); return rows.map(paymentIntentFromRow); },
    async updateStatus(id: string, status: PaymentIntentStatus, patch: Partial<PaymentIntent> = {}): Promise<PaymentIntent | null> { const current = await this.findById(id); if (!current) return null; const next = { ...current, ...patch, status, updatedAt: new Date().toISOString() } as PaymentIntent; await this.save(next); return next; }
  },
  notifications: {
    async listSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> { const { rows } = await pool().query('select * from push_subscriptions where user_id=$1 and revoked_at is null order by updated_at desc', [userId]); return rows.map(subscriptionFromRow); },
    async saveSubscription(s: PushSubscriptionRecord): Promise<void> { await pool().query(`insert into push_subscriptions(id,user_id,endpoint,p256dh,auth,user_agent,device_label,created_at,updated_at,last_seen_at,revoked_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(endpoint) do update set user_id=$2,p256dh=$4,auth=$5,user_agent=$6,device_label=$7,updated_at=$9,last_seen_at=$10,revoked_at=$11`, [s.id,s.userId,s.endpoint,s.p256dh,s.auth,s.userAgent??null,s.deviceLabel??null,s.createdAt,s.updatedAt,s.lastSeenAt,s.revokedAt??null]); },
    async revokeSubscription(subscriptionId: string, userId: string): Promise<boolean> { const { rowCount } = await pool().query('update push_subscriptions set revoked_at=now(), updated_at=now() where id=$1 and user_id=$2 and revoked_at is null', [subscriptionId,userId]); return Number(rowCount) > 0; },
    async getPreferences(userId: string): Promise<NotificationPreferences | null> { await ensureFriendMessagePref(); const { rows } = await pool().query('select * from notification_preferences where user_id=$1', [userId]); return rows[0] ? preferencesFromRow(rows[0]) : null; },
    /* Writes the new column only when it is really there. If the ALTER could not
     * run, the old eight-column statement is used and the chat switch simply
     * does not persist — which is a setting nobody can save, not a game nobody
     * can play. */
    async savePreferences(prefs: NotificationPreferences): Promise<void> {
      const hasCol = await ensureFriendMessagePref();
      if (hasCol) {
        await pool().query(`insert into notification_preferences(user_id,match_updates,leaderboard_updates,wallet_updates,promos,friend_messages,quiet_hours_start,quiet_hours_end,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(user_id) do update set match_updates=$2,leaderboard_updates=$3,wallet_updates=$4,promos=$5,friend_messages=$6,quiet_hours_start=$7,quiet_hours_end=$8,updated_at=$9`, [prefs.userId,prefs.matchUpdates,prefs.leaderboardUpdates,prefs.walletUpdates,prefs.promos,prefs.friendMessages!==false,prefs.quietHoursStart??null,prefs.quietHoursEnd??null,prefs.updatedAt]);
        return;
      }
      await pool().query(`insert into notification_preferences(user_id,match_updates,leaderboard_updates,wallet_updates,promos,quiet_hours_start,quiet_hours_end,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(user_id) do update set match_updates=$2,leaderboard_updates=$3,wallet_updates=$4,promos=$5,quiet_hours_start=$6,quiet_hours_end=$7,updated_at=$8`, [prefs.userId,prefs.matchUpdates,prefs.leaderboardUpdates,prefs.walletUpdates,prefs.promos,prefs.quietHoursStart??null,prefs.quietHoursEnd??null,prefs.updatedAt]);
    },
    async listNotifications(userId: string, limit = 50): Promise<NotificationRecord[]> { const { rows } = await pool().query('select * from notifications where user_id=$1 order by created_at desc limit $2', [userId, limit]); return rows.map(notificationFromRow); },
    async saveNotification(n: NotificationRecord): Promise<void> { await pool().query(`insert into notifications(id,user_id,type,title,body,data,channel,status,created_at,sent_at,read_at,error) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(id) do update set status=$8,sent_at=$10,read_at=$11,error=$12`, [n.id,n.userId,n.type,n.title,n.body,JSON.stringify(n.data),n.channel,n.status,n.createdAt,n.sentAt??null,n.readAt??null,n.error??null]); },
    async markRead(notificationId: string, userId: string): Promise<boolean> { const { rowCount } = await pool().query("update notifications set read_at=coalesce(read_at,now()), status='read' where id=$1 and user_id=$2", [notificationId,userId]); return Number(rowCount) > 0; },
    async markAllRead(userId: string): Promise<number> { const { rowCount } = await pool().query("update notifications set read_at=coalesce(read_at,now()), status='read' where user_id=$1 and read_at is null", [userId]); return Number(rowCount); }
  }
};

function subscriptionFromRow(r: any): PushSubscriptionRecord { return { id:r.id, userId:r.user_id, endpoint:r.endpoint, p256dh:r.p256dh, auth:r.auth, userAgent:r.user_agent ?? undefined, deviceLabel:r.device_label ?? undefined, createdAt:r.created_at?.toISOString?.() ?? r.created_at, updatedAt:r.updated_at?.toISOString?.() ?? r.updated_at, lastSeenAt:r.last_seen_at?.toISOString?.() ?? r.last_seen_at, revokedAt:r.revoked_at?.toISOString?.() ?? r.revoked_at ?? undefined }; }
/* CREATE TABLE IF NOT EXISTS never adds a column to a table that already
 * exists, so a database created before this column existed would not have it.
 * The migration file adds it for a fresh install; this adds it for the ones
 * already out there, once per process.
 *
 * IT MUST NEVER THROW, and the first version of it did.
 *
 * getPreferences sits underneath notifications.create(), and create() is
 * awaited WITHOUT a catch on the paths that buy a ticket, finish a match, and
 * request a withdrawal. A schema statement that can fail — no ALTER
 * permission, a lock, an unreachable database for one moment — was therefore a
 * schema statement that could make buying a ticket return 500. A player must
 * never be unable to play because a notification preference could not be
 * migrated. The answer is reported, logged once, and carried in a flag the
 * writer reads; it is retried on the next call in case the condition was
 * temporary. */
let _friendPrefReady: Promise<boolean> | null = null;
let _friendPrefWarned = false;
function ensureFriendMessagePref(): Promise<boolean> {
  if (!_friendPrefReady) {
    _friendPrefReady = pool()
      .query('alter table notification_preferences add column if not exists friend_messages boolean not null default true')
      .then(() => true)
      .catch((e) => {
        _friendPrefReady = null;                       // try again next time
        if (!_friendPrefWarned) {
          _friendPrefWarned = true;
          logger.warn('friend_message_pref_column_missing', { message: e instanceof Error ? e.message : 'unknown' });
        }
        return false;
      });
  }
  return _friendPrefReady;
}
/* An older row has no friend_messages value at all; absent must read as ON,
 * because silently withholding a message is worse than one the player can
 * switch off. */
function preferencesFromRow(r: any): NotificationPreferences { return { userId:r.user_id, matchUpdates:r.match_updates, leaderboardUpdates:r.leaderboard_updates, walletUpdates:r.wallet_updates, promos:r.promos, friendMessages:r.friend_messages !== false, quietHoursStart:r.quiet_hours_start ?? undefined, quietHoursEnd:r.quiet_hours_end ?? undefined, updatedAt:r.updated_at?.toISOString?.() ?? r.updated_at }; }
function notificationFromRow(r: any): NotificationRecord { return { id:r.id, userId:r.user_id, type:r.type, title:r.title, body:r.body, data:r.data ?? {}, channel:r.channel, status:r.status, createdAt:r.created_at?.toISOString?.() ?? r.created_at, sentAt:r.sent_at?.toISOString?.() ?? r.sent_at ?? undefined, readAt:r.read_at?.toISOString?.() ?? r.read_at ?? undefined, error:r.error ?? undefined }; }


function answerFromRow(r: any): AnswerSubmission { return { id:r.id, matchId:r.match_id, userId:r.user_id, questionId:r.question_id, selectedIndex:r.selected_index, correct:r.correct, answerTimeMs:r.answer_time_ms, idempotencyKey:r.idempotency_key, createdAt:r.created_at?.toISOString?.() ?? r.created_at }; }
function integrityFromRow(r: any): IntegritySignal { return { id:r.id, matchId:r.match_id, userId:r.user_id, questionId:r.question_id ?? undefined, type:r.type, severity:r.severity, riskScore:Number(r.risk_score), status:r.status, evidence:r.evidence ?? {}, createdAt:r.created_at?.toISOString?.() ?? r.created_at, reviewedAt:r.reviewed_at?.toISOString?.() ?? r.reviewed_at ?? undefined, reviewedBy:r.reviewed_by ?? undefined }; }


function deviceFromRow(r: any): DeviceRecord { return { id:r.id, fingerprintHash:r.fingerprint_hash, clientDeviceId:r.client_device_id ?? undefined, userAgent:r.user_agent ?? undefined, platform:r.platform ?? undefined, firstIpAddress:r.first_ip_address ?? undefined, lastIpAddress:r.last_ip_address ?? undefined, firstSeenAt:r.first_seen_at?.toISOString?.() ?? r.first_seen_at, lastSeenAt:r.last_seen_at?.toISOString?.() ?? r.last_seen_at, trustStatus:r.trust_status, revokedAt:r.revoked_at?.toISOString?.() ?? r.revoked_at ?? undefined }; }
function bindingFromRow(r: any): UserDeviceBinding { return { id:r.id, userId:r.user_id, deviceId:r.device_id, firstSeenAt:r.first_seen_at?.toISOString?.() ?? r.first_seen_at, lastSeenAt:r.last_seen_at?.toISOString?.() ?? r.last_seen_at, lastIpAddress:r.last_ip_address ?? undefined, trustStatus:r.trust_status, riskScore:Number(r.risk_score ?? 0) }; }
function riskProfileFromRow(r: any): UserRiskProfile { return { userId:r.user_id, riskScore:Number(r.risk_score ?? 0), riskLevel:r.risk_level, reasons:r.reasons ?? [], deviceCount:Number(r.device_count ?? 0), sharedDeviceCount:Number(r.shared_device_count ?? 0), integritySignalCount:Number(r.integrity_signal_count ?? 0), updatedAt:r.updated_at?.toISOString?.() ?? r.updated_at }; }


function rewardHoldFromRow(r: any): RewardHold { return { id:r.id, rewardId:r.reward_id, userId:r.user_id, matchId:r.match_id, rewardType:r.reward_type, amount:Number(r.amount), status:r.status, riskScore:Number(r.risk_score), riskLevel:r.risk_level, reason:r.reason, evidence:r.evidence ?? {}, idempotencyKey:r.idempotency_key, createdAt:r.created_at?.toISOString?.() ?? r.created_at, reviewedAt:r.reviewed_at?.toISOString?.() ?? r.reviewed_at ?? undefined, reviewedBy:r.reviewed_by ?? undefined, releasedAt:r.released_at?.toISOString?.() ?? r.released_at ?? undefined }; }


function transactionFromRow(r: any): Transaction { return { id:r.id, userId:r.user_id, type:r.type, currency:r.currency, amount:Number(r.amount), direction:r.direction, status:r.status, reference:r.reference, createdAt:r.created_at?.toISOString?.() ?? r.created_at }; }


function supportTicketFromRow(r: any): SupportTicket { return { id:r.id, userId:r.user_id, title:r.title, category:r.category, body:r.body, status:r.status, priority:r.priority, reply:r.reply ?? undefined, linkedMatchId:r.linked_match_id ?? undefined, linkedTransactionId:r.linked_transaction_id ?? undefined, linkedRewardHoldId:r.linked_reward_hold_id ?? undefined, assignedAdminId:r.assigned_admin_id ?? undefined, createdAt:r.created_at?.toISOString?.() ?? r.created_at, updatedAt:r.updated_at?.toISOString?.() ?? r.updated_at, closedAt:r.closed_at?.toISOString?.() ?? r.closed_at ?? undefined }; }
function supportMessageFromRow(r: any): SupportMessage { return { id:r.id, ticketId:r.ticket_id, senderId:r.sender_id, senderRole:r.sender_role, body:r.body, createdAt:r.created_at?.toISOString?.() ?? r.created_at }; }


function characterItemFromRow(r: any): CharacterItem { return { id:r.id, slot:r.slot, title:r.title, src:r.src, rarity:r.rarity, priceCoins:Number(r.price_coins), unlockLevel:Number(r.unlock_level ?? 1), tags:r.tags ?? [], status:r.status, createdAt:r.created_at?.toISOString?.() ?? r.created_at, updatedAt:r.updated_at?.toISOString?.() ?? r.updated_at }; }
function characterInventoryFromRow(r: any): CharacterInventory { return { userId:r.user_id, unlockedItemIds:r.unlocked_item_ids ?? [], loadout:r.loadout, updatedAt:r.updated_at?.toISOString?.() ?? r.updated_at }; }
function characterUnlockEventFromRow(r: any): CharacterUnlockEvent { return { id:r.id, userId:r.user_id, itemId:r.item_id, reason:r.reason, createdAt:r.created_at?.toISOString?.() ?? r.created_at }; }


function paymentIntentFromRow(r: any): PaymentIntent { return { id:r.id, userId:r.user_id, provider:r.provider, amount:Number(r.amount), currency:r.currency, status:r.status, transactionId:r.transaction_id, paymentUrl:r.payment_url, callbackUrl:r.callback_url ?? undefined, providerReference:r.provider_reference ?? undefined, idempotencyKey:r.idempotency_key, metadata:r.metadata ?? {}, createdAt:r.created_at?.toISOString?.() ?? r.created_at, updatedAt:r.updated_at?.toISOString?.() ?? r.updated_at, paidAt:r.paid_at?.toISOString?.() ?? r.paid_at ?? undefined, failedAt:r.failed_at?.toISOString?.() ?? r.failed_at ?? undefined }; }


function errorReportFromRow(r: any): ErrorReport { return { id:r.id, userId:r.user_id ?? undefined, source:r.source, severity:r.severity, status:r.status, message:r.message, stack:r.stack ?? undefined, route:r.route ?? undefined, userAgent:r.user_agent ?? undefined, appVersion:r.app_version ?? undefined, buildId:r.build_id ?? undefined, deviceId:r.device_id ?? undefined, metadata:r.metadata ?? {}, createdAt:r.created_at?.toISOString?.() ?? r.created_at, resolvedAt:r.resolved_at?.toISOString?.() ?? r.resolved_at ?? undefined, resolvedBy:r.resolved_by ?? undefined }; }


function betaInviteFromRow(r: any): BetaInvite { return { code:r.code, maxUses:Number(r.max_uses), usedCount:Number(r.used_count), status:r.status, note:r.note ?? undefined, createdBy:r.created_by ?? 'system', createdAt:r.created_at?.toISOString?.() ?? r.created_at, expiresAt:r.expires_at?.toISOString?.() ?? r.expires_at ?? undefined }; }
function betaAccessFromRow(r: any): BetaAccess { return { userId:r.user_id, inviteCode:r.invite_code, grantedAt:r.granted_at?.toISOString?.() ?? r.granted_at, grantedBy:r.granted_by ?? 'system' }; }
