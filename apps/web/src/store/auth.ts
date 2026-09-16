import type { AuthUser } from "@timesheet/shared";
import { create } from "zustand";
import { adoptSavedAppearance } from "../lib/theme";
import { setAccessToken } from "../services/api";

interface AuthState {
  user?: AuthUser;
  hydrated: boolean;
  setSession: (user: AuthUser, accessToken: string) => void;
  setUser: (user?: AuthUser) => void;
  logout: () => void;
}

/**
 * Only the in-memory access token + the current user object live here — the refresh token
 * is an httpOnly cookie the browser manages on its own (see services/api.ts). Nothing here
 * persists to localStorage: a page reload always re-derives session state by attempting
 * `/auth/refresh` against the cookie (see App.tsx's AuthBootstrap), not by reading a stored token.
 */
/**
 * A saved appearance is adopted HERE, in the store, and not in AuthBootstrap.
 *
 * Three code paths produce a signed-in user — the cold-load refresh in App.tsx, the Login page's
 * `setSession`, and SSO completion — and all three funnel through these two setters. Hooking the
 * bootstrap alone would have applied the saved theme on reload but not on the sign-in that just
 * happened, which is the one moment somebody is actually watching. A profile with nothing saved is
 * a no-op, so the deploy that adds this changes nobody's screen.
 */
export const useAuthStore = create<AuthState>((set) => ({
  user: undefined,
  hydrated: false,
  setSession: (user, accessToken) => {
    setAccessToken(accessToken);
    adoptSavedAppearance(user.appearance);
    set({ user, hydrated: true });
  },
  setUser: (user) => {
    adoptSavedAppearance(user?.appearance);
    set({ user, hydrated: true });
  },
  logout: () => {
    setAccessToken(null);
    set({ user: undefined, hydrated: true });
  }
}));
