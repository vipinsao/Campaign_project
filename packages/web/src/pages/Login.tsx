import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ApiError, api, readToken, storeSession } from '../lib/api.ts';
import type { LoginResponse } from '../lib/types.ts';
import { ErrorState } from '../components/States.tsx';

type Candidate = { tenantId: string; userId: string; role: string };

function candidatesOf(details: unknown): Candidate[] {
  if (typeof details !== 'object' || details === null) return [];
  const list = (details as Record<string, unknown>).candidates;
  if (!Array.isArray(list)) return [];
  return (list as Record<string, unknown>[])
    .filter((row) => typeof row.tenantId === 'string')
    .map((row) => ({
      tenantId: String(row.tenantId),
      userId: String(row.userId ?? ''),
      role: String(row.role ?? ''),
    }));
}

/**
 * Sign in, plus the one case most login screens do not have.
 *
 * `/auth/login` returns **409 ambiguous_account** when the same address and
 * password match operator accounts in more than one tenant — an agency running
 * three brands. The API refuses to pick, and so does this screen: it renders the
 * candidate tenants from `error.details` and makes the operator choose. Signing
 * somebody into whichever row sorted first is I13 in a different costume.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (readToken() !== null) return <Navigate to="/campaigns" replace />;

  const candidates = error instanceof ApiError && error.code === 'ambiguous_account'
    ? candidatesOf(error.details)
    : [];

  async function submit(withTenant: string | null) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<LoginResponse>('/auth/login', {
        email: email.trim(),
        password,
        ...(withTenant === null ? {} : { tenantId: withTenant }),
      });
      storeSession(result.token, result.user);
      await navigate('/campaigns', { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded bg-accent-dim font-mono text-[13px] font-bold text-white">
            ce
          </span>
          <div>
            <div className="text-[15px] leading-tight font-semibold">Campaign Engine</div>
            <div className="text-[11px] leading-tight text-ink-faint">operator console</div>
          </div>
        </div>

        <form
          className="panel p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(tenantId);
          }}
        >
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input mb-3"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(event) => { setEmail(event.target.value); }}
            placeholder="operator@example.com"
          />

          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input mb-4"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => { setPassword(event.target.value); }}
            placeholder="••••••••••••"
          />

          {tenantId !== null && (
            <div className="mb-3 flex items-center justify-between gap-2 rounded border border-accent-dim bg-accent-wash px-2 py-1.5 text-[11px]">
              <span className="truncate font-mono text-accent">tenant {tenantId.slice(0, 8)}</span>
              <button
                type="button"
                className="text-ink-faint hover:text-ink"
                onClick={() => { setTenantId(null); }}
              >
                clear
              </button>
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary w-full justify-center py-2"
            disabled={busy || email.trim().length === 0 || password.length === 0}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {candidates.length > 0 && (
          <div className="panel mt-3 p-4">
            <div className="panel-title mb-1">Which tenant?</div>
            <p className="mb-3 text-[12px] leading-relaxed text-ink-dim">
              Those credentials are valid in {candidates.length} tenants. The API refuses to choose
              one for you, and so does this screen.
            </p>
            <div className="space-y-1.5">
              {candidates.map((candidate) => (
                <button
                  key={candidate.tenantId}
                  type="button"
                  className="btn w-full justify-between"
                  onClick={() => {
                    setTenantId(candidate.tenantId);
                    void submit(candidate.tenantId);
                  }}
                >
                  <span className="font-mono text-[11px]">{candidate.tenantId}</span>
                  <span className="text-ink-faint">{candidate.role}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {error !== null && candidates.length === 0 && <ErrorState error={error} title="Sign-in failed" />}

        <p className="mt-5 text-center text-[11px] leading-relaxed text-ink-faint">
          Seeded by <code className="font-mono">npm run seed:demo</code>. The API rejects a bad
          address and a bad password with the same sentence, on purpose — telling them apart is an
          account-enumeration oracle.
        </p>
      </div>
    </div>
  );
}
