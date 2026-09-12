# BluPal — the card-to-card gateway

## What the player sees

1. They tap «درگاه پرداخت» in the shop.
2. The API opens a BluPal invoice for the order's price **in rial** and answers
   with BluPal's own payment page.
3. A sheet tells them the amount and sends them there when they press the
   button — never automatically, because an in-app browser can swallow a
   scripted navigation and because a player about to be sent to their bank
   should be the one who decides to go.
4. They transfer the money, card to card, and come back to
   `https://www.prizequiz.ir/?pay=back`.
5. The game asks the API «did it arrive?». The API asks **BluPal**, over its own
   connection with its own key. If BluPal says paid, for the exact rial figure
   recorded when the invoice was opened, the ticket is issued.

Their bank transfer is minutes, not seconds, so what they were buying is written
to `localStorage` **before** they leave and checked again every time the game
opens for the next 6 hours. A player who closes the tab still gets their ticket.

## What BluPal must be told

In BluPal's panel:

| Setting       | Value                                                |
|---------------|------------------------------------------------------|
| Webhook URL   | `https://www.prizequiz.ir/v1/payments/blupal/webhook` |
| Callback page | `https://www.prizequiz.ir/?pay=back`                  |

## What the server must be told

`BLUPAL_API_KEY` in `/home/ubuntu/.env`, passed through
`docker-compose.override.yml` as `"${BLUPAL_API_KEY}"`. Never in the admin
panel, never in a browser, never in a chat.

`BLUPAL_BASE_URL` is optional and defaults to `https://blupal.net/api`.

## The two rules this integration is built on

**1. The webhook is a nudge, never evidence.**

BluPal's webhook carries no signature — no HMAC, no shared secret, nothing in
their contract. Their own verification advice is «check the invoice_id against
your database», which only proves that *we* opened that invoice. It says nothing
whatever about anybody having paid it, and anyone who learns an invoice id could
post it.

So the only thing taken from a webhook body is an invoice number, and all that
does is say **which** invoice to go and ask BluPal about. A stranger posting
invoice ids all day can make the endpoint do lookups and nothing else.

**2. Rial is not toman.**

BluPal counts in rial; PrizzeQuizz counts in toman. A stray ×10 in a payment
path is a ten-fold error in real money and the two figures look identical in a
log, so the conversion lives in exactly one place (`blupalService.ts`) and the
rial figure that counts as paid is written into the intent when the invoice is
opened — never recomputed at settlement from anything the caller supplies.

## A test key on a live server

`blupalMode()` reads the world off the key itself: a key starting `blu_live_` is
live, anything else is sandbox. A sandbox invoice can be marked paid without any
money moving, so `verifyPaid` refuses any invoice whose mode is not the key's
own — a test key cannot deliver goods against a live invoice, and a live key
cannot be tricked by a sandbox one.

Running a **test** key on production is allowed, because that is how you first
try the flow end to end. It logs `blupal_sandbox_key_in_production` on every
invoice it opens. Nothing sold through it has really been paid for.

## Delivering exactly once

A card-to-card gateway retries its callback for a long time, so duplicates are
the normal case. Two guards stand behind it:

- `payment_intents` is claimed with a conditional status flip, so exactly one
  caller settles an intent;
- `order_fulfilments` (see `fulfilmentGuard.ts`) marks the delivery itself in
  **Postgres**, so a deploy in the middle of a retry run cannot pay out twice —
  which a `Set` in the process's memory, what this used to be, could not manage.

The table is created at runtime as well as by migration `026`, because a
`dist`-only deploy carries no migrations.

A claim that is never settled — a process killed mid-delivery — is taken over
after `FULFILMENT_LEASE_MS` (default 120s) so a paying player is never left with
nothing, and every takeover logs `fulfilment_lease_taken_over`, because a
takeover means something crashed.

## Checking it works

```
curl -s https://www.prizequiz.ir/v1/payments/gateway
```

`{"cardToCard":true,"mode":"live","live":true}` means the key is loaded and real.
`"mode":"sandbox"` means it is a test key. `"cardToCard":false` means the API
cannot see `BLUPAL_API_KEY` at all — it was set after the container was created,
and env vars are fixed at creation: use `up -d --no-build api`, not `restart`.
