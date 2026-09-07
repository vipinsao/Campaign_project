import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiError } from '../lib/api.ts';
import {
  storefront,
  type CheckoutResponse,
  type Product,
  type StorefrontConfigResponse,
} from '../lib/storefront.ts';
import {
  Pill,
  QueueStatusPill,
  ChannelBadge,
  ReasonChip,
  DecisionChip,
} from '../components/Pill.tsx';
import { ErrorState, LoadingState } from '../components/States.tsx';

/**
 * The storefront: sixty seconds, one click, a real message.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Everything else in this product is an operator console, and an operator console
 * is unreviewable by a stranger — you cannot judge a queue screen without knowing
 * what should be in the queue. This page exists so the engine can be judged from
 * the outside: place an order, and either something arrives on your own phone or
 * it does not.
 *
 * The second screen is the one that is actually about the product. Any shop can
 * send a confirmation email. The interesting artefact is the panel underneath it,
 * which lists every decision the engine made — including the messages it refused
 * to send, the gate that refused them, and the sentence explaining why. That is
 * the claim this whole repository makes, rendered for somebody who will not read
 * the source.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PAGE PROMISES, AND WHAT IT REFUSES TO PROMISE
 *
 * It asks the API what this deployment can actually do before it renders the
 * form, and it says so plainly — in mock mode, that nothing will reach a real
 * inbox; in live mode, which provider will carry it. A demo that implies an SMS
 * is coming and then silently sends nothing is worse than one that says up front
 * that SMS is not configured, because the first one costs the visitor their trust
 * in everything else on the page.
 */

const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', GBP: '£', EUR: '€', INR: '₹' };

function money(amount: number, currency: string): string {
  return `${CURRENCY_SYMBOL[currency] ?? ''}${amount.toFixed(2)}`;
}

export function ShopPage() {
  const config = useQuery({
    queryKey: ['storefront', 'config'],
    queryFn: storefront.config,
    staleTime: 30_000,
  });

  const [cart, setCart] = useState<Record<string, number>>({});
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [marketingConsent, setMarketingConsent] = useState(false);
  /**
   * The honeypot, held in state rather than left as a loose DOM node.
   *
   * The form submits JSON built from state, not a FormData scrape, so an input
   * nothing reads is decoration — a headless browser could fill it and the value
   * would never leave the page. Bound here, a script that fills every input it
   * finds sends the field, and the API answers 200 and does nothing.
   */
  const [website, setWebsite] = useState('');
  const [placed, setPlaced] = useState<CheckoutResponse | null>(null);

  const catalogue = config.data?.catalogue ?? [];
  const currency = config.data?.currency ?? 'USD';

  const lines = useMemo(
    () =>
      catalogue
        .filter((product) => (cart[product.sku] ?? 0) > 0)
        .map((product) => ({ product, qty: cart[product.sku] ?? 0 })),
    [catalogue, cart],
  );
  const total = lines.reduce((sum, line) => sum + line.product.price * line.qty, 0);

  const checkout = useMutation({
    mutationFn: () =>
      storefront.checkout({
        name,
        email,
        ...(phone.trim() === '' ? {} : { phone }),
        items: lines.map((line) => ({ sku: line.product.sku, qty: line.qty })),
        marketingConsent,
        website,
      }),
    onSuccess: (result) => {
      setPlaced(result);
      setCart({});
    },
  });

  if (config.isLoading)
    return (
      <ShopShell>
        <LoadingState rows={4} label="Opening the shop" />
      </ShopShell>
    );
  if (config.isError)
    return (
      <ShopShell>
        <ErrorState error={config.error} title="The shop is closed" />
      </ShopShell>
    );

  if (placed !== null && placed.receiptToken !== null) {
    return (
      <ShopShell>
        <ReceiptView
          token={placed.receiptToken}
          checkout={placed}
          onAgain={() => {
            setPlaced(null);
            checkout.reset();
          }}
        />
      </ShopShell>
    );
  }

  const canSubmit =
    lines.length > 0 && name.trim().length > 0 && /.+@.+\..+/.test(email) && !checkout.isPending;

  return (
    <ShopShell>
      <Capabilities config={config.data} />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-[12px] font-semibold tracking-wide text-ink uppercase">
              Catalogue
            </h2>
            <span className="text-[11px] text-ink-faint">Nothing is charged. Nothing ships.</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {catalogue.map((product) => (
              <ProductCard
                key={product.sku}
                product={product}
                currency={currency}
                qty={cart[product.sku] ?? 0}
                onChange={(qty) => {
                  setCart((previous) => ({ ...previous, [product.sku]: qty }));
                }}
              />
            ))}
          </div>
        </div>

        <form
          className="panel h-fit p-4 lg:sticky lg:top-4"
          onSubmit={(event) => {
            event.preventDefault();
            checkout.mutate();
          }}
        >
          <div className="panel-title mb-3">Checkout</div>

          {lines.length === 0 ? (
            <p className="mb-4 rounded border border-dashed border-line-strong px-3 py-4 text-center text-[12px] text-ink-faint">
              Add something to the basket.
            </p>
          ) : (
            <ul className="mb-3 space-y-1">
              {lines.map((line) => (
                <li key={line.product.sku} className="flex justify-between text-[12px]">
                  <span className="text-ink-dim">
                    {line.product.name} <span className="text-ink-faint">× {line.qty}</span>
                  </span>
                  <span className="num">{money(line.product.price * line.qty, currency)}</span>
                </li>
              ))}
              <li className="flex justify-between border-t border-line pt-1.5 text-[12px] font-semibold">
                <span>Total</span>
                <span className="num">{money(total, currency)}</span>
              </li>
            </ul>
          )}

          <label className="label" htmlFor="shop-name">
            Name
          </label>
          <input
            id="shop-name"
            className="input mb-3"
            value={name}
            autoComplete="name"
            placeholder="Ada Lovelace"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />

          <label className="label" htmlFor="shop-email">
            Email — the receipt goes here
          </label>
          <input
            id="shop-email"
            className="input mb-3"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />

          <label className="label" htmlFor="shop-phone">
            Phone, with country code — optional
          </label>
          <input
            id="shop-phone"
            className="input mb-1"
            type="tel"
            autoComplete="tel"
            placeholder="+447700900123"
            value={phone}
            onChange={(event) => {
              setPhone(event.target.value);
            }}
          />
          <p className="mb-3 text-[11px] leading-relaxed text-ink-faint">
            {config.data?.channels.sms.live === true
              ? config.data.channels.sms.whatsapp === true
                ? 'This deployment sends SMS over the Twilio WhatsApp sandbox, so it only reaches numbers that have joined it. If yours has not, the receipt will say exactly that rather than pretending.'
                : 'Leave it blank and the receipt will show the SMS being skipped, with the reason — which is worth seeing too.'
              : 'SMS is not configured on this deployment. Leave it blank, or fill it in to watch the engine record precisely why nothing was sent.'}
          </p>

          {/*
            The honeypot. Hidden from people and from screen readers, present in
            the DOM for anything that fills every input it finds. `tabIndex={-1}`
            and `autoComplete="off"` keep a real browser from ever touching it.
          */}
          <div aria-hidden className="hidden">
            <label htmlFor="shop-website">Website</label>
            <input
              id="shop-website"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(event) => {
                setWebsite(event.target.value);
              }}
            />
          </div>

          <label className="mb-4 flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-ink-dim">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={marketingConsent}
              onChange={(event) => {
                setMarketingConsent(event.target.checked);
              }}
            />
            <span>
              Email me about offers. Recorded as a consent row with its evidence — and it will not
              override an earlier opt-out, which is the point.
            </span>
          </label>

          <button
            type="submit"
            className="btn btn-primary w-full justify-center py-2"
            disabled={!canSubmit}
          >
            {checkout.isPending ? 'Placing the order…' : `Place order · ${money(total, currency)}`}
          </button>

          {checkout.isError && (
            <ErrorState error={checkout.error} title={errorTitle(checkout.error)} />
          )}

          <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
            Your address is used for this one message and nothing else. Every message carries a
            working unsubscribe link, and the whole dataset is wiped and reseeded nightly.
          </p>
        </form>
      </div>
    </ShopShell>
  );
}

function errorTitle(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) return 'Slow down';
  if (error instanceof ApiError && error.code === 'storefront_not_seeded') return 'Not seeded yet';
  return 'The order was not placed';
}

/** The standalone route, for the link the receipt hands out. */
export function ShopReceiptPage() {
  const token = useParams().token ?? '';
  return (
    <ShopShell>
      <ReceiptView token={token} checkout={null} />
    </ShopShell>
  );
}

function ShopShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full bg-ground">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Link to="/shop" className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded bg-accent-dim font-mono text-[13px] font-bold text-white">
              ce
            </span>
            <span>
              <span className="block text-[15px] leading-tight font-semibold">The Engine Shop</span>
              <span className="block text-[11px] leading-tight text-ink-faint">
                a real checkout, wired to a real messaging engine
              </span>
            </span>
          </Link>
          <Link to="/campaigns" className="btn btn-ghost">
            Operator console →
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-5">{children}</main>
      <footer className="mx-auto max-w-6xl px-4 pb-8 text-[11px] leading-relaxed text-ink-faint">
        Campaign Engine — a multi-channel lifecycle messaging engine that can prove why it did not
        send. This shop sells nothing; it exists so the engine can be judged from the outside.
      </footer>
    </div>
  );
}

function Capabilities({ config }: { config: StorefrontConfigResponse | undefined }) {
  if (config === undefined) return null;
  const { email, sms } = config.channels;
  const anyLive = email.live || sms.live;

  return (
    <div className="panel mb-4 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="panel-title">What this deployment will actually do</span>
        <Pill tone={anyLive ? 'ok' : 'info'}>
          {anyLive ? 'live sending' : `SEND_MODE=${config.sendMode}`}
        </Pill>
        {config.budget.limit > 0 && anyLive && (
          <Pill tone={config.budget.remaining > 0 ? 'quiet' : 'held'} mono>
            {config.budget.remaining}/{config.budget.limit} sends left today
          </Pill>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {(
          [
            ['email', email],
            ['sms', sms],
          ] as const
        ).map(([channel, capability]) => (
          <div key={channel} className="rounded border border-line bg-ground/50 px-3 py-2">
            <div className="mb-1 flex items-center gap-2">
              <ChannelBadge channel={channel} />
              <Pill tone={capability.live ? 'ok' : 'quiet'}>
                {capability.live ? 'reaches you for real' : 'simulated'}
              </Pill>
              {capability.provider !== null && (
                <span className="font-mono text-[10px] text-ink-faint">{capability.provider}</span>
              )}
            </div>
            <p className="text-[11px] leading-relaxed text-ink-dim">{capability.detail}</p>
            {typeof capability.joinInstructions === 'string' && (
              <p className="mt-1.5 rounded border border-held/35 bg-held-wash px-2 py-1.5 text-[11px] leading-relaxed text-held">
                {capability.joinInstructions}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductCard({
  product,
  currency,
  qty,
  onChange,
}: {
  product: Product;
  currency: string;
  qty: number;
  onChange: (qty: number) => void;
}) {
  return (
    <div className="panel flex flex-col gap-2 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold">{product.name}</span>
        <span className="num text-ink-dim">{money(product.price, currency)}</span>
      </div>
      <p className="flex-1 text-[11px] leading-relaxed text-ink-faint">{product.blurb}</p>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-ink-faint">{product.sku}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn px-2 py-0.5"
            disabled={qty === 0}
            onClick={() => {
              onChange(qty - 1);
            }}
            aria-label={`Remove one ${product.name}`}
          >
            −
          </button>
          <span className="num w-6 text-center">{qty}</span>
          <button
            type="button"
            className="btn px-2 py-0.5"
            disabled={qty >= 5}
            onClick={() => {
              onChange(qty + 1);
            }}
            aria-label={`Add one ${product.name}`}
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The receipt, and why it polls.
 *
 * The send happens inside the checkout request, so the first render already has
 * the outcome. What it does NOT have is the delivery receipt: a provider calls
 * back seconds to minutes after accepting a message, and `delivered_at` is written
 * only by that callback (I9) — never inferred from a successful send. So the page
 * keeps asking for a little while, and the row moves from `sent` to `delivered`
 * in front of the visitor.
 *
 * It stops after two minutes. A page that polls forever is a page that is still
 * polling in a background tab tomorrow.
 */
function ReceiptView({
  token,
  checkout,
  onAgain,
}: {
  token: string;
  checkout: CheckoutResponse | null;
  onAgain?: () => void;
}) {
  const [startedAt] = useState(() => Date.now());

  const receipt = useQuery({
    queryKey: ['storefront', 'receipt', token],
    queryFn: () => storefront.receipt(token),
    refetchInterval: (query) => {
      if (Date.now() - startedAt > 120_000) return false;
      const settled = (query.state.data?.messages ?? []).every(
        (message) => message.status !== 'sent' && message.status !== 'processing',
      );
      return settled ? false : 3_000;
    },
  });

  if (receipt.isLoading) return <LoadingState rows={4} label="Reading the decision log" />;
  if (receipt.isError) return <ErrorState error={receipt.error} title="No such receipt" />;
  const data = receipt.data;
  if (data === undefined) return null;

  return (
    <div className="space-y-4">
      <div className="panel p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="text-[15px] font-semibold">
              Order {data.order.number} placed
              {data.contact.firstName === null ? '' : `, thanks ${data.contact.firstName}`}
            </div>
            <div className="text-[12px] text-ink-dim">
              {data.order.currency} {data.order.total} ·{' '}
              {data.order.items.map((item) => `${item.name} × ${String(item.qty)}`).join(', ')}
            </div>
          </div>
          {onAgain !== undefined && (
            <button type="button" className="btn" onClick={onAgain}>
              Place another
            </button>
          )}
        </div>

        {checkout !== null && checkout.notes.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {checkout.notes.map((note) => (
              <li
                key={note}
                className="rounded border border-held/35 bg-held-wash px-3 py-2 text-[11px] leading-relaxed text-held"
              >
                {note}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
          Keep this link to come back to it:{' '}
          <code className="font-mono text-ink-dim">/shop/receipt/{token.slice(0, 12)}…</code> — it
          is signed, so it opens this order and no other.
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-[12px] font-semibold tracking-wide text-ink uppercase">
          Messages this order produced
        </h2>
        {data.messages.length === 0 ? (
          <div className="panel p-4 text-[12px] text-ink-dim">
            No message was queued. The decision log below says why — that is not an error page, it
            is the answer.
          </div>
        ) : (
          <div className="space-y-2">
            {data.messages.map((message) => (
              <article key={message.id} className="panel p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <ChannelBadge channel={message.channel} />
                  <QueueStatusPill status={message.status} />
                  <span className="text-[11px] text-ink-dim">→ {message.to}</span>
                  <span className="ml-auto font-mono text-[10px] text-ink-faint">
                    {message.provider ?? 'no provider'}
                    {message.providerMessageId === null
                      ? ''
                      : ` · ${message.providerMessageId.slice(0, 24)}`}
                  </span>
                </div>
                {message.subject !== null && (
                  <div className="mb-1 text-[13px] font-semibold">{message.subject}</div>
                )}
                <pre className="overflow-x-auto rounded border border-line bg-ground/60 px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-dim">
                  {message.body}
                </pre>
                {message.errorCode !== null && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <ReasonChip code={message.errorCode} />
                    <span className="text-[11px] text-bad">{message.errorMessage}</span>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-ink-faint">
                  <span>attempt {message.attempts}</span>
                  {message.sentAt !== null && (
                    <span>sent {new Date(message.sentAt).toLocaleTimeString()}</span>
                  )}
                  {message.deliveredAt !== null && (
                    <span className="text-ok">
                      delivery receipt {new Date(message.deliveredAt).toLocaleTimeString()}
                    </span>
                  )}
                  {message.sentAt !== null &&
                    message.deliveredAt === null &&
                    (data.deliveryReceiptsExpected ? (
                      <span>waiting for the provider&rsquo;s delivery receipt…</span>
                    ) : (
                      <span title="delivered_at is written only by a provider callback (I9), never inferred from a successful send">
                        accepted by the mock provider — no delivery receipt in mock mode
                      </span>
                    ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-[12px] font-semibold tracking-wide text-ink uppercase">
          Every decision, including the refusals
        </h2>
        <p className="mb-2 text-[11px] leading-relaxed text-ink-faint">
          This is the part that is hard to build and easy to skip. A campaign that did not fire, a
          message that was not queued and a send that was refused each leave a row here, with the
          gate that decided and the facts it decided on.
        </p>
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className="th">Stage</th>
                <th className="th">Decision</th>
                <th className="th">Reason</th>
                <th className="th">Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.decisions.map((decision, index) => (
                <tr
                  key={`${decision.at}-${String(index)}`}
                  className="border-b border-line/60 last:border-0"
                >
                  <td className="cell text-[11px] text-ink-dim">
                    {decision.stage}
                    {decision.campaign === null ? '' : ` · ${decision.campaign}`}
                  </td>
                  <td className="cell">
                    <DecisionChip decision={decision.decision} />
                  </td>
                  <td className="cell">
                    <ReasonChip code={decision.reasonCode} />
                  </td>
                  <td className="cell text-[11px] leading-relaxed text-ink-dim">
                    {decision.detail}
                  </td>
                </tr>
              ))}
              {data.decisions.length === 0 && (
                <tr>
                  <td className="cell text-[12px] text-ink-faint" colSpan={4}>
                    No decisions recorded for this order.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
