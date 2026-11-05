"use client";

// ─────────────────────────────────────────────────────────────────────────────
// AdminAuthPanel — login + break-glass + ré-enrôlement TOTP (ADM Étape 3).
// Client minimal : 3 champs au login (un seul round-trip), CSRF gardé en
// mémoire (jamais persisté), le cookie de session est HttpOnly (invisible ici).
// L'état initial (session ou pas) est calculé CÔTÉ SERVEUR par page.tsx —
// aucun useEffect de chargement ici (règle react-hooks/set-state-in-effect).
// Aucun secret n'est affiché en clair sauf le flux break-glass (nouveau secret
// TOTP, montré une fois, par conception — voir ADM-step3-4.md).
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useState } from "react";

export interface AuthPanelInitial {
  authenticated: boolean;
  email: string;
  role: string;
  totpEnrolled: boolean;
}

type PanelState =
  | { phase: "anonymous" }
  | { phase: "authed"; email: string; role: string; totpEnrolled: boolean };

export function AdminAuthPanel({ initial }: { initial: AuthPanelInitial }) {
  const [state, setState] = useState<PanelState>(
    initial.authenticated
      ? { phase: "authed", email: initial.email, role: initial.role, totpEnrolled: initial.totpEnrolled }
      : { phase: "anonymous" }
  );
  const csrfRef = useRef<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // break-glass : nouveau secret TOTP à enrôler (affiché UNE fois)
  const [pendingEnroll, setPendingEnroll] = useState<{ totpSecret: string; otpauthUrl: string } | null>(null);
  const [showBreakGlass, setShowBreakGlass] = useState(false);

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
          totp: String(form.get("totp") ?? "").replace(/\s+/g, ""),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 200) {
        csrfRef.current = String(body.csrfToken ?? "");
        setState({
          phase: "authed",
          email: String(body.email ?? ""),
          role: String(body.role ?? ""),
          totpEnrolled: body.totpEnrolled === true,
        });
      } else if (res.status === 429) {
        setError("Trop de tentatives — réessayez dans quelques minutes.");
      } else {
        setError("Identifiants invalides.");
      }
    } catch {
      setError("App principale injoignable.");
    } finally {
      setBusy(false);
    }
  }

  async function handleBreakGlass(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/admin/auth/break-glass", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: String(form.get("bg-email") ?? ""),
          code: String(form.get("bg-code") ?? ""),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 200) {
        csrfRef.current = String(body.csrfToken ?? "");
        setPendingEnroll({
          totpSecret: String(body.totpSecret ?? ""),
          otpauthUrl: String(body.otpauthUrl ?? ""),
        });
        setState({ phase: "authed", email: String(body.email ?? ""), role: String(body.role ?? ""), totpEnrolled: false });
        setShowBreakGlass(false);
      } else if (res.status === 429) {
        setError("Trop de tentatives — réessayez dans quelques minutes.");
      } else {
        setError("Code de secours invalide ou déjà utilisé.");
      }
    } catch {
      setError("App principale injoignable.");
    } finally {
      setBusy(false);
    }
  }

  async function handleEnroll(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/admin/auth/totp-enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-csrf": csrfRef.current },
        body: JSON.stringify({ code: String(form.get("enroll-code") ?? "").replace(/\s+/g, "") }),
      });
      if (res.status === 200) {
        setPendingEnroll(null);
        setState((s) => (s.phase === "authed" ? { ...s, totpEnrolled: true } : s));
      } else {
        setError("Code TOTP invalide.");
      }
    } catch {
      setError("App principale injoignable.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    setBusy(true);
    try {
      await fetch("/api/admin/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-csrf": csrfRef.current },
      });
      csrfRef.current = "";
      setPendingEnroll(null);
      setState({ phase: "anonymous" });
    } finally {
      setBusy(false);
    }
  }

  if (state.phase === "authed") {
    return (
      <div className="space-y-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="font-medium text-zinc-500">Compte</dt>
          <dd className="text-zinc-900">{state.email}</dd>
          <dt className="font-medium text-zinc-500">Rôle</dt>
          <dd>
            <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">
              {state.role}
            </span>
          </dd>
          <dt className="font-medium text-zinc-500">TOTP</dt>
          <dd className={state.totpEnrolled ? "text-emerald-700" : "text-amber-700"}>
            {state.totpEnrolled ? "enrôlé" : "ré-enrôlement requis"}
          </dd>
        </dl>

        {pendingEnroll && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4" data-testid="pending-enroll">
            <p className="text-sm font-medium text-amber-900">Ré-enrôlement TOTP requis</p>
            <p className="mt-1 text-xs text-amber-800">
              Secret (saisie manuelle, montré une fois) :{" "}
              <code className="rounded bg-amber-100 px-1 py-0.5">{pendingEnroll.totpSecret}</code>
            </p>
            <p className="mt-1 break-all text-xs text-amber-800">URI : {pendingEnroll.otpauthUrl}</p>
            <form onSubmit={handleEnroll} className="mt-3 flex gap-2">
              <input
                name="enroll-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="Code du nouveau TOTP"
                className="w-44 rounded-md border border-amber-300 px-3 py-2 text-sm"
                aria-label="Code TOTP du nouveau secret"
                required
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                Finaliser l&apos;enrôlement
              </button>
            </form>
          </div>
        )}

        {!state.totpEnrolled && !pendingEnroll && (
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
            TOTP non enrôlé — reconnectez-vous (le premier login validé finalise
            l&apos;enrôlement) ou utilisez break-glass si le secret est perdu.
          </p>
        )}

        <button
          type="button"
          onClick={handleLogout}
          disabled={busy}
          data-testid="logout-btn"
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          Se déconnecter
        </button>
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleLogin} className="space-y-3" data-testid="login-form">
        <div className="grid gap-1">
          <label htmlFor="login-email" className="text-sm font-medium text-zinc-700">
            Email
          </label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="username"
            required
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="login-password" className="text-sm font-medium text-zinc-700">
            Mot de passe
          </label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="login-totp" className="text-sm font-medium text-zinc-700">
            Code TOTP (6 chiffres)
          </label>
          <input
            id="login-totp"
            name="totp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,8}"
            required
            className="w-40 rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          data-testid="login-btn"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {busy ? "Connexion…" : "Se connecter"}
        </button>
      </form>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="border-t border-zinc-100 pt-3">
        <button
          type="button"
          onClick={() => setShowBreakGlass((v) => !v)}
          aria-expanded={showBreakGlass}
          data-testid="breakglass-toggle"
          className="text-xs font-medium text-zinc-500 underline hover:text-zinc-700"
        >
          Téléphone perdu ? Utiliser un code de secours (break-glass)
        </button>
        {showBreakGlass && (
          <form onSubmit={handleBreakGlass} className="mt-3 space-y-3" data-testid="breakglass-form">
            <div className="grid gap-1">
              <label htmlFor="bg-email" className="text-sm font-medium text-zinc-700">
                Email
              </label>
              <input
                id="bg-email"
                name="bg-email"
                type="email"
                required
                className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="grid gap-1">
              <label htmlFor="bg-code" className="text-sm font-medium text-zinc-700">
                Code de secours
              </label>
              <input
                id="bg-code"
                name="bg-code"
                required
                className="rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm"
                placeholder="XXXX-XXXX-…"
              />
            </div>
            <p className="text-xs text-zinc-500">
              Le code sera brûlé (usage unique), toutes vos sessions seront
              révoquées et un nouveau TOTP vous sera demandé.
            </p>
            <button
              type="submit"
              disabled={busy}
              data-testid="breakglass-btn"
              className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
            >
              Utiliser le code de secours
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
