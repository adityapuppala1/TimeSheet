import { create } from "zustand";
import type { PlatformAdminUser } from "../services/platform-admin-api";
import { setPlatformAdminAccessToken } from "../services/platform-admin-api";

/** Deliberately a separate store from store/auth.ts's useAuthStore — see
 *  services/platform-admin-api.ts's header comment for why these two auth states never share
 *  any client-side state. */
interface PlatformAdminAuthState {
  admin?: PlatformAdminUser;
  hydrated: boolean;
  setSession: (admin: PlatformAdminUser, accessToken: string) => void;
  setAdmin: (admin?: PlatformAdminUser) => void;
  logout: () => void;
}

/**
 * A one-bit hint in localStorage: "this browser has, at some point, held a platform-admin
 * session." It is NOT the session and grants nothing — the httpOnly refresh cookie is still the
 * only thing that can restore one.
 *
 * WHY IT EXISTS: the bootstrap in App.tsx used to fire `POST /platform-admin/auth/refresh` on
 * EVERY cold load, for every visitor — and a tenant user (or a logged-out stranger) has no such
 * cookie, so the server correctly answered 401. Harmless, but it put a red 401 in the console of
 * every ordinary user on every load, which reads as a bug. This marker lets the bootstrap skip the
 * request entirely for anyone who has never signed into the platform-admin console here, so the
 * refresh is attempted only when there is genuinely a session to restore.
 */
const SEEN_KEY = "ts:platform-admin-seen";

export function hasSeenPlatformAdminSession(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // Private mode / storage blocked. Fall back to attempting the refresh — the old behaviour,
    // so a real admin in a locked-down browser still gets their session restored.
    return true;
  }
}

function rememberPlatformAdminSession(seen: boolean): void {
  try {
    if (seen) localStorage.setItem(SEEN_KEY, "1");
    else localStorage.removeItem(SEEN_KEY);
  } catch {
    /* storage unavailable — the bootstrap falls back to attempting the refresh, which is fine */
  }
}

export const usePlatformAdminAuthStore = create<PlatformAdminAuthState>((set) => ({
  admin: undefined,
  hydrated: false,
  setSession: (admin, accessToken) => {
    setPlatformAdminAccessToken(accessToken);
    rememberPlatformAdminSession(true);
    set({ admin, hydrated: true });
  },
  // NOTE: deliberately does not touch the marker. This is the bootstrap's own callback, and it is
  // called with `undefined` on a failed refresh — clearing the marker there would defeat the point
  // (a transient failure would stop all future restore attempts). Only an explicit logout clears it.
  setAdmin: (admin) => set({ admin, hydrated: true }),
  logout: () => {
    setPlatformAdminAccessToken(null);
    rememberPlatformAdminSession(false);
    set({ admin: undefined, hydrated: true });
  }
}));
