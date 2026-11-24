import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import clsx from 'clsx';
import { clearSession, isDemoSession, readOperator } from '../lib/api.ts';

/**
 * The shell: a fixed rail, a dense content column, and no wizards anywhere.
 *
 * The keyboard map is `g` followed by a letter, the same idiom Linear and GitHub
 * use, because the people who live in an operator console all day do not reach for
 * the mouse to change page. `/` focuses the page's search box where there is one.
 */

type NavItem = { to: string; label: string; key: string; icon: keyof typeof ICONS; end?: boolean };

/**
 * Icons as inline SVG paths, not Unicode glyphs.
 *
 * The rail used to use characters like ⌖ and ⛨, which many fonts — including the
 * defaults on a fresh Linux machine — do not have, so the menu rendered empty
 * boxes. A path renders the same everywhere and takes `currentColor`.
 */
const ICONS = {
  campaigns: 'M4 6h16M4 12h16M4 18h10',
  queue: 'M4 7h12M4 12h12M4 17h12M19 7v10',
  inspect: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM20 20l-4.2-4.2',
  outbox: 'M3 7l9 6l9-6M3 7v10h18V7H3z',
  invariants: 'M12 3l7 3v5c0 4.5-3 8-7 10c-4-2-7-5.5-7-10V6l7-3zM9 12l2 2l4-4',
} as const;

function NavIcon({ name, className }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={clsx('size-3.5 shrink-0', className)}
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

const NAV: readonly NavItem[] = [
  { to: '/campaigns', label: 'Campaigns', key: 'c', icon: 'campaigns' },
  { to: '/queue', label: 'Queue', key: 'q', icon: 'queue' },
  { to: '/inspect', label: 'Inspect', key: 'i', icon: 'inspect' },
  { to: '/mock-outbox', label: 'Mock outbox', key: 'o', icon: 'outbox' },
  { to: '/invariants', label: 'Invariants', key: 'v', icon: 'invariants' },
];

export function Layout() {
  const navigate = useNavigate();
  const operator = readOperator();
  const demo = isDemoSession();
  const [chord, setChord] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      if (chord) {
        const item = NAV.find((entry) => entry.key === event.key.toLowerCase());
        setChord(false);
        if (item !== undefined) {
          event.preventDefault();
          void navigate(item.to);
        }
        return;
      }
      if (event.key === 'g') {
        setChord(true);
        window.setTimeout(() => {
          setChord(false);
        }, 1200);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [chord, navigate]);

  useEffect(() => {
    const onSignOut = () => {
      void navigate('/login', { replace: true });
    };
    window.addEventListener('campaign:signed-out', onSignOut);
    return () => {
      window.removeEventListener('campaign:signed-out', onSignOut);
    };
  }, [navigate]);

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav className="flex shrink-0 flex-col border-b border-line bg-surface md:w-52 md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-4 py-2.5 md:py-3.5">
          <span className="grid size-6 place-items-center rounded bg-accent-dim font-mono text-[11px] font-bold text-white">
            ce
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] leading-tight font-semibold">Campaign Engine</div>
            <div className="truncate text-[10px] leading-tight text-ink-faint">
              operator console
            </div>
          </div>
          <NavLink to="/shop" className="btn btn-ghost px-2 py-1 text-[12px] md:hidden">
            Shop →
          </NavLink>
        </div>

        {/*
          One list, two shapes: a scrolling row of tabs on a phone, the rail on
          anything wider. A 208px rail on a 390px screen leaves the content 180px,
          which is not a layout, it is a bug report.
        */}
        <div className="flex gap-0.5 overflow-x-auto px-2 pb-2 md:flex-1 md:flex-col md:overflow-visible md:py-1 md:pb-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                clsx(
                  'group flex shrink-0 items-center gap-2 rounded px-2 py-1.5 text-[13px] whitespace-nowrap transition-colors md:gap-2.5',
                  isActive
                    ? 'bg-accent-wash text-ink'
                    : 'text-ink-dim hover:bg-raised hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <NavIcon
                    name={item.icon}
                    className={isActive ? 'text-accent' : 'text-ink-faint'}
                  />
                  <span className="truncate md:flex-1">{item.label}</span>
                  <span className="kbd hidden opacity-0 transition-opacity group-hover:opacity-100 md:inline">
                    g {item.key}
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </div>

        {chord && (
          <div className="mx-2 mb-2 hidden rounded border border-accent-dim bg-accent-wash px-2 py-1 text-[11px] text-accent md:block">
            g … {NAV.map((item) => item.key).join(' ')}
          </div>
        )}

        <div className="hidden border-t border-line px-3 py-2.5 md:block">
          {demo ? (
            <>
              <div className="truncate text-[12px] text-ink-dim">Public demo session</div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">
                {operator?.role ?? '—'} · {operator?.email ?? '—'}
              </div>
              <NavLink to="/shop" className="mt-2 block text-[11px] text-accent hover:underline">
                ← Back to the shop
              </NavLink>
            </>
          ) : (
            <>
              <div className="truncate text-[12px] text-ink-dim">
                {operator?.email ?? 'not signed in'}
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2">
                <span
                  className="truncate font-mono text-[10px] text-ink-faint"
                  title={`tenant ${operator?.tenantId ?? 'unknown'}`}
                >
                  {operator?.role ?? '—'} · {operator?.tenantId.slice(0, 8) ?? '—'}
                </span>
                <button
                  type="button"
                  className="text-[11px] text-ink-faint hover:text-bad"
                  onClick={() => {
                    clearSession();
                  }}
                >
                  sign out
                </button>
              </div>
            </>
          )}
        </div>
      </nav>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {demo && <DemoBanner />}
        <Outlet />
      </main>
    </div>
  );
}

/**
 * What a visitor needs to know before they touch anything, in one line.
 *
 * Without it, a stranger who opens the console from a CV link cannot tell whether
 * they are looking at somebody's production system, whether clicking "Pause" is
 * safe, or why their own address shows up half-hidden.
 */
function DemoBanner() {
  return (
    <div className="shrink-0 border-b border-accent-dim/40 bg-accent-wash px-4 py-1.5 text-[11px] leading-relaxed text-ink-dim md:px-5">
      <span className="font-semibold text-accent">Public demo</span> — no sign-in, full operator
      access to a seeded store. Changes reset nightly at 04:00 UTC, and other visitors&rsquo; emails
      and phone numbers are masked.{' '}
      <NavLink to="/shop" className="text-accent hover:underline">
        Place an order in the shop
      </NavLink>{' '}
      and watch it arrive under Queue and Inspect.
    </div>
  );
}

/** The page header every screen shares: title, subtitle, and a slot for actions. */
export function PageHeader({
  title,
  subtitle,
  actions,
  tabs,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  tabs?: React.ReactNode;
}) {
  return (
    <header className="shrink-0 border-b border-line bg-surface/60 px-4 pt-3 md:px-5 md:pt-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 pb-3">
        <div className="min-w-0">
          <h1 className="truncate text-[15px] leading-tight font-semibold">{title}</h1>
          {subtitle !== undefined && (
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-dim">{subtitle}</p>
          )}
        </div>
        {actions !== undefined && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
      {tabs !== undefined && <div className="-mx-1 overflow-x-auto px-1">{tabs}</div>}
    </header>
  );
}

export function Scroll({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
}
