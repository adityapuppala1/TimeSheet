import type { AuthUser } from "@timesheet/shared";
import { create } from "zustand";
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
export const useAuthStore = create<AuthState>((set) => ({
  user: undefined,
  hydrated: false,
  setSession: (user, accessToken) => {
    setAccessToken(accessToken);
    set({ user, hydrated: true });
  },
  setUser: (user) => set({ user, hydrated: true }),
  logout: () => {
    setAccessToken(null);
    set({ user: undefined, hydrated: true });
  }
}));
