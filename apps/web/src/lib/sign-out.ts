/**
 * WHAT: the one sign-out sequence both entry points use — the account menu (AccountMenu.tsx) and the
 * command palette (command-palette.tsx).
 *
 * WHY IT REPORTS AN OUTCOME (security audit #9). Both used to swallow any error from
 * `POST /auth/logout` and toast "Signed out". When that call had failed, the server session and the
 * httpOnly refresh cookie — which page JavaScript cannot delete — were both still alive, and the next
 * page load restored the session: on a shared machine, for the next person, who had been told the
 * opposite. Now the caller is told whether the server confirmed it, and says so.
 *
 * Local state is cleared EITHER WAY, and only after the server has answered — so the request still
 * carries the access token, and this tab stops acting as the person the moment they asked it to.
 */
export type SignOutOutcome = "signed-out" | "unconfirmed";

export async function signOut(steps: { endSession: () => Promise<unknown>; clearLocal: () => void }): Promise<SignOutOutcome> {
  let outcome: SignOutOutcome = "signed-out";
  try {
    await steps.endSession();
  } catch {
    outcome = "unconfirmed";
  }
  steps.clearLocal();
  return outcome;
}

/** What to tell the person when the server could not confirm it. Shared so both entry points say
 *  the same true thing. */
export const SIGN_OUT_UNCONFIRMED = {
  title: "Couldn't confirm sign-out",
  description:
    "This tab is signed out, but the server didn't answer, so your session may still be active in this browser. Sign out again once you're back online, or close the browser if this is a shared computer."
} as const;
