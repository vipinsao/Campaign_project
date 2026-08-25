import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import clsx from 'clsx';
import { clearSession, readOperator } from '../lib/api.ts';

/**
 * The shell: a fixed rail, a dense content column, and no wizards anywhere.
 *
 * The keyboard map is `g` followed by a letter, the same idiom Linear and GitHub
 * use, because the people who live in an operator console all day do not reach for
 * the mouse to change page. `/` focuses the page's search box where there is one.
 */

type NavItem = { to: string; label: string; key: string; glyph: string; end?: boolean };

const NAV: readonly NavItem[] = [
  { to: '/campaigns', label: 'Campaigns', key: 'c', glyph: '◈' },
  { to: '/queue', label: 'Queue', key: 'q', glyph: '≡' },
  { to: '/inspect', label: 'Inspect', key: 'i', glyph: '⌖' },
  { to: '/mock-outbox', label: 'Mock outbox', key: 'o', glyph: '✉' },
  { to: '/invariants', label: 'Invariants', key: 'v', glyph: '⛨' },
];

export function Layout() {
  const navigate = useNavigate();
  const operator = readOperator();
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
    <div className="flex h-full min-h-0">
      <nav className="flex w-52 shrink-0 flex-col border-r border-line bg-surface">
        <div className="flex items-center gap-2 px-4 py-3.5">
          <span className="grid size-6 place-items-center rounded bg-accent-dim font-mono text-[11px] font-bold text-white">
            ce
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] leading-tight font-semibold">Campaign Engine</div>
            <div className="truncate text-[10px] leading-tight text-ink-faint">
              operator console
            </div>
          </div>
        </div>

        <div className="flex-1 space-y-0.5 px-2 py-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                clsx(
                  'group flex items-center gap-2.5 rounded px-2 py-1.5 text-[13px] transition-colors',
                  isActive
                    ? 'bg-accent-wash text-ink'
                    : 'text-ink-dim hover:bg-raised hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={clsx(
                      'w-3.5 text-center font-mono text-[12px]',
                      isActive ? 'text-accent' : 'text-ink-faint',
                    )}
                  >
                    {item.glyph}
                  </span>
                  <span className="flex-1 truncate">{item.label}</span>
                  <span className="kbd opacity-0 transition-opacity group-hover:opacity-100">
                    g {item.key}
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </div>

        {chord && (
          <div className="mx-2 mb-2 rounded border border-accent-dim bg-accent-wash px-2 py-1 text-[11px] text-accent">
            g … {NAV.map((item) => item.key).join(' ')}
          </div>
        )}

        <div className="border-t border-line px-3 py-2.5">
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
        </div>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
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
    <header className="shrink-0 border-b border-line bg-surface/60 px-5 pt-4">
      <div className="flex items-start justify-between gap-4 pb-3">
        <div className="min-w-0">
          <h1 className="truncate text-[15px] leading-tight font-semibold">{title}</h1>
          {subtitle !== undefined && (
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-dim">{subtitle}</p>
          )}
        </div>
        {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {tabs}
    </header>
  );
}

export function Scroll({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
}
