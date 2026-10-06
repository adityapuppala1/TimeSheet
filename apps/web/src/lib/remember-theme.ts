import { authApi } from "../services/api";
import { useAuthStore } from "../store/auth";
import { currentAccent, currentDensity, type Theme } from "./theme";

/**
 * Save a quick theme switch (nav-bar toggle, command palette) to the signed-in person's profile.
 *
 * WHY: a saved profile appearance is re-adopted on every sign-in AND every reload (store/auth.ts →
 * adoptSavedAppearance), and it deliberately wins over localStorage. The toggle only wrote
 * localStorage, so someone whose profile said "dark" flipped to light, refreshed, and was put back
 * in dark. The Profile page saved both and so never showed it. Now every switch is a profile save.
 *
 * Fire-and-forget: the theme is already applied here; a failed save only means it will not follow
 * the person to another device. No signed-in tenant user (login page, platform console) → nothing
 * to save, and nothing is sent.
 */
export function rememberTheme(mode: Theme): void {
  const { user, setUser } = useAuthStore.getState();
  if (!user) return;
  authApi
    .updateProfile({ appearance: { mode, accent: currentAccent(), density: currentDensity() } })
    .then((updated) => setUser(updated))
    .catch(() => undefined);
}
