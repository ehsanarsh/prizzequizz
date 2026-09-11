/* WHAT THE PLAYER MAY PAY WITH, DECIDED HERE AND NOWHERE ELSE.
 *
 * The payment sheet used to be built from two booleans, which worked while
 * there was one gateway and one answer. With a card-to-card gateway that can
 * refuse an order the redirect gateway would accept — because the amount is
 * under the bank's SMS floor, or today's cap is spent — «can I pay by gateway»
 * stopped being a yes or no.
 *
 * So the server sends the sheet itself: one row per method, already ordered,
 * already labelled, already carrying the sentence to show underneath. Three
 * rules keep it that way:
 *
 * 1. `selectable` IS THE SERVER'S WORD. A method can be open (`state: 'live'`)
 *    and still not selectable for THIS order — the صندوق with too little in
 *    it, card-to-card under the floor. The client colours; it does not judge.
 *
 * 2. `note` IS FINISHED PERSIAN. The client never composes a sentence from
 *    `state`, because the day a fourth state appears every cached build would
 *    be writing something wrong about it.
 *
 * 3. A HIDDEN GATEWAY IS ABSENT, NOT GREYED OUT. «پنهان» means the operator
 *    does not want it seen at all; sending it disabled would still show it.
 */
import { formatTomanFa } from './money.js';
import { listGateways, type GatewayAvailability } from './paymentGatewayService.js';
import { eligibleCards, lowestFloorToman } from './c2c/cardService.js';
import { isGatewayPayable, type OrderQuote } from './purchaseOrderService.js';

export type MethodKind = 'vault' | 'card_to_card' | 'gateway_redirect';

export interface PaymentMethodOption {
  /** What `orders/pay` is called back with: 'vault', or a gateway id. */
  id: string;
  kind: MethodKind;
  label: string;
  state: GatewayAvailability;
  selectable: boolean;
  /** Ready to print under the row. Never assembled on the client. */
  note: string;
}

export interface MethodContext {
  /** صندوق جایزه balance, Toman. */
  vaultToman: number;
  /** The player's coins, for coin-priced shop items. */
  coins: number;
}

/* Asked once per quote and reused for every card-to-card gateway on the sheet:
 * an operator with two card-to-card rows should not cost two table scans. */
async function cardToCardNote(amountToman: number): Promise<{ selectable: boolean; note: string }> {
  const { eligible, rejected } = await eligibleCards(amountToman);
  if (eligible.length) return { selectable: true, note: 'تأیید خودکار پس از واریز' };

  /* WHY there is no card is the whole value of this row. «زیر کف مبلغ» is
   * something the player can fix by buying a larger package; «سقف امروز پر
   * است» is ours and they should try another way instead. Telling them apart
   * before they choose is the point — after choosing, it is a dead end. */
  if (rejected.some((r) => r.why === 'BELOW_SMS_FLOOR')) {
    const floor = await lowestFloorToman();
    return {
      selectable: false,
      note: `برای کارت‌به‌کارت، مبلغ خرید باید بیشتر از ${formatTomanFa(Number(floor ?? 0))} باشد.`
    };
  }
  if (rejected.some((r) => r.why === 'DAILY_CAP_REACHED')) {
    return { selectable: false, note: 'سقف واریز امروز تکمیل شده است؛ فردا دوباره امکان‌پذیر می‌شود.' };
  }
  return { selectable: false, note: 'فعلاً در دسترس نیست.' };
}

/**
 * The sheet for one priced order.
 *
 * Nothing here charges, reserves or allocates: it is a look at the doors, and
 * a door that is open now can still be full by the time the player walks
 * through it. `orders/pay` re-checks everything — this exists so the player is
 * not asked to choose something that was never going to work.
 */
export async function paymentMethodsFor(q: OrderQuote, ctx: MethodContext): Promise<PaymentMethodOption[]> {
  const out: PaymentMethodOption[] = [];

  if (q.currency === 'coins') {
    /* A coin-priced item never touches the صندوق — the shop debits coins. It
     * is still `method: 'vault'` on the wire, because that is the endpoint's
     * name for «pay with what you already have». */
    const enough = ctx.coins >= q.amount;
    out.push({
      id: 'vault', kind: 'vault', label: 'سکه‌های من', state: 'live', selectable: enough,
      note: enough
        ? `${q.amount.toLocaleString('fa-IR')} سکه کم می‌شود`
        : `سکه‌ات کافی نیست (${ctx.coins.toLocaleString('fa-IR')} سکه)`
    });
    /* No gateway takes money for a coin price, so none is listed. An empty
     * greyed-out row would only invite a support ticket. */
    return out;
  }

  const enough = ctx.vaultToman >= q.amount;
  out.push({
    id: 'vault', kind: 'vault', label: 'صندوق جایزه', state: 'live', selectable: enough,
    note: enough
      ? `از موجودی صندوق کم می‌شود (${formatTomanFa(ctx.vaultToman)})`
      : `موجودی صندوق کافی نیست (${formatTomanFa(ctx.vaultToman)})`
  });

  if (!isGatewayPayable(q)) return out;

  /* Panel priority is display order: `listGateways` already sorts by it, and
   * the client must not re-sort — an operator who moves a row expects the
   * sheet to move with it. */
  let c2c: { selectable: boolean; note: string } | null = null;
  for (const g of await listGateways()) {
    if (g.availability === 'hidden') continue;
    const kind: MethodKind = g.type === 'card_to_card' ? 'card_to_card' : 'gateway_redirect';
    let selectable = g.availability === 'live';
    let note = g.availability === 'live' ? 'انتقال به صفحهٔ پرداخت بانک' : 'به‌زودی';

    if (kind === 'card_to_card' && g.availability === 'live') {
      c2c ??= await cardToCardNote(q.amount);
      selectable = c2c.selectable;
      note = c2c.note;
    } else if (kind === 'card_to_card') {
      note = 'به‌زودی';
    }

    out.push({ id: g.id, kind, label: g.name, state: g.availability, selectable, note });
  }
  return out;
}
