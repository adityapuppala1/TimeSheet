import type { AuthUser } from "@timesheet/shared";
import { create } from "zustand";

interface AuthState {
  user?: AuthUser;
  hydrated: boolean;
  setSession: (user: AuthUser, accessToken: string, refreshToken: string) => void;
  setUser: (user?: AuthUser) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: undefined,
  hydrated: false,
  setSession: (user, accessToken, refreshToken) => {
    localStorage.setItem("accessToken", accessToken);
    localStorage.setItem("refreshToken", refreshToken);
    set({ user, hydrated: true });
  },
  setUser: (user) => set({ user, hydrated: true }),
  logout: () => {
    localStorage.removeItem("accessToken");
    localStorage.removeItem("refreshToken");
    set({ user: undefined, hydrated: true });
  }
}));
