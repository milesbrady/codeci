import { create } from "zustand";

interface AuthState {
  token: string | null;
  totpPassed: boolean;
  username: string | null;
  isAdmin: boolean;
  mustChangePassword: boolean;
  bootstrapping: boolean;
  setAuth: (token: string, totpPassed: boolean, username: string) => void;
  setMustChangePassword: (v: boolean) => void;
  logout: () => void;
  isExpired: () => boolean;
}

interface ParsedToken {
  totpPassed: boolean;
  username: string;
  isAdmin: boolean;
  exp: number; // unix seconds; 0 if missing
}

function parseToken(token: string): ParsedToken {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return {
      totpPassed: Boolean(payload.totp),
      username: String(payload.sub ?? ""),
      isAdmin: Boolean(payload.admin),
      exp: typeof payload.exp === "number" ? payload.exp : 0,
    };
  } catch {
    return { totpPassed: false, username: "", isAdmin: false, exp: 0 };
  }
}

function tokenExpired(parsed: ParsedToken): boolean {
  if (!parsed.exp) return false;
  return parsed.exp * 1000 <= Date.now();
}

// Cross-tab session sync uses these keys as a transient message bus only —
// values are written and immediately removed, so the token never actually
// persists in localStorage. Per CLAUDE.md the token must live only in
// sessionStorage so the session dies when the last tab closes.
const SESSION_REQUEST_KEY = "__tsi_session_request__";
const SESSION_SHARE_KEY = "__tsi_session_share__";
// Window in which we'll wait for another tab to share its session before
// concluding there isn't one and falling through to /login.
const SESSION_SYNC_TIMEOUT_MS = 200;

// Read existing token from sessionStorage. If it's already expired, drop it
// before the store initializes — avoids the store starting "logged in" only to
// be kicked back out by the first 401.
const storedRaw = sessionStorage.getItem("token");
let stored: string | null = storedRaw;
let initial: ParsedToken = { totpPassed: false, username: "", isAdmin: false, exp: 0 };
if (storedRaw) {
  initial = parseToken(storedRaw);
  if (tokenExpired(initial)) {
    sessionStorage.removeItem("token");
    sessionStorage.removeItem("must_change_password");
    stored = null;
    initial = { totpPassed: false, username: "", isAdmin: false, exp: 0 };
  }
}
const storedMustChange = sessionStorage.getItem("must_change_password") === "1";

// If this tab boots without a session, briefly wait for another tab to share
// theirs before redirecting to login.
const needsBootstrap = !stored;

export const useAuthStore = create<AuthState>((set, get) => ({
  token: stored,
  totpPassed: initial.totpPassed,
  username: stored ? initial.username : null,
  isAdmin: initial.isAdmin,
  mustChangePassword: storedMustChange,
  bootstrapping: needsBootstrap,

  setAuth: (token, totpPassed, username) => {
    sessionStorage.setItem("token", token);
    const parsed = parseToken(token);
    set({ token, totpPassed, username, isAdmin: parsed.isAdmin, bootstrapping: false });
  },

  setMustChangePassword: (v) => {
    if (v) {
      sessionStorage.setItem("must_change_password", "1");
    } else {
      sessionStorage.removeItem("must_change_password");
    }
    set({ mustChangePassword: v });
  },

  logout: () => {
    sessionStorage.removeItem("token");
    sessionStorage.removeItem("must_change_password");
    // Best-effort permission-cache wipe so a future user on the same tab
    // doesn't briefly see the previous user's nav. Lazy-imported to avoid
    // a top-level circular import (permissions store also reads /api).
    import("./permissions")
      .then((m) => m.usePermissionsStore.getState().reset())
      .catch(() => {});
    set({
      token: null,
      totpPassed: false,
      username: null,
      isAdmin: false,
      mustChangePassword: false,
      bootstrapping: false,
    });
  },

  isExpired: () => {
    const t = get().token;
    if (!t) return false;
    return tokenExpired(parseToken(t));
  },
}));

function adoptSharedSession(raw: string) {
  if (useAuthStore.getState().token) return;
  try {
    const data = JSON.parse(raw) as { token?: string; must_change_password?: boolean };
    if (!data.token) return;
    const parsed = parseToken(data.token);
    if (tokenExpired(parsed)) return;
    sessionStorage.setItem("token", data.token);
    if (data.must_change_password) {
      sessionStorage.setItem("must_change_password", "1");
    }
    useAuthStore.setState({
      token: data.token,
      totpPassed: parsed.totpPassed,
      username: parsed.username,
      isAdmin: parsed.isAdmin,
      mustChangePassword: !!data.must_change_password,
      bootstrapping: false,
    });
  } catch {
    // ignore malformed payloads
  }
}

try {
  window.addEventListener("storage", (e) => {
    if (!e.key || !e.newValue) return;
    if (e.key === SESSION_REQUEST_KEY) {
      // Another tab is asking for a session — share ours if we have one.
      const token = sessionStorage.getItem("token");
      if (!token) return;
      const payload = JSON.stringify({
        token,
        must_change_password: sessionStorage.getItem("must_change_password") === "1",
      });
      try {
        localStorage.setItem(SESSION_SHARE_KEY, payload);
        localStorage.removeItem(SESSION_SHARE_KEY);
      } catch {
        // localStorage may be blocked (private mode in some browsers); nothing we can do.
      }
    } else if (e.key === SESSION_SHARE_KEY) {
      adoptSharedSession(e.newValue);
    }
  });

  if (needsBootstrap) {
    try {
      localStorage.setItem(SESSION_REQUEST_KEY, String(Date.now()));
      localStorage.removeItem(SESSION_REQUEST_KEY);
    } catch {
      // localStorage unavailable — give up on sync and fall through to login.
    }
    window.setTimeout(() => {
      if (useAuthStore.getState().bootstrapping) {
        useAuthStore.setState({ bootstrapping: false });
      }
    }, SESSION_SYNC_TIMEOUT_MS);
  }
} catch {
  // window unavailable (SSR or similarly restricted env) — skip sync entirely.
}
