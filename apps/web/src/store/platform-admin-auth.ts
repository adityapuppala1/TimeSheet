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

export const usePlatformAdminAuthStore = create<PlatformAdminAuthState>((set) => ({
  admin: undefined,
  hydrated: false,
  setSession: (admin, accessToken) => {
    setPlatformAdminAccessToken(accessToken);
    set({ admin, hydrated: true });
  },
  setAdmin: (admin) => set({ admin, hydrated: true }),
  logout: () => {
    setPlatformAdminAccessToken(null);
    set({ admin: undefined, hydrated: true });
  }
}));
