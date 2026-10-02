/**
 * Signing out from the SPA (security audit #9).
 *
 * THE DEFECT: both sign-out entry points (the account menu and the command palette) swallowed any
 * error from `POST /auth/logout` and toasted "Signed out". When the call had failed, the server
 * session and the httpOnly refresh cookie were both still alive, and the next page load restored the
 * session — on a shared machine, for the next person, who had been told the opposite.
 *
 * Pinned: local state is cleared EITHER WAY (the person asked to leave, and this tab must stop
 * acting as them), and the outcome is reported honestly so the caller can say "we could not confirm
 * that" instead of "Signed out".
 */
import { describe, expect, it, vi } from "vitest";
import { signOut } from "../../src/lib/sign-out";

describe("signOut", () => {
  it("reports a confirmed sign-out when the server ended the session", async () => {
    const clearLocal = vi.fn();
    expect(await signOut({ endSession: vi.fn().mockResolvedValue(undefined), clearLocal })).toBe("signed-out");
    expect(clearLocal).toHaveBeenCalledTimes(1);
  });

  it("still clears local state when the server call fails — and says so instead of claiming success", async () => {
    const clearLocal = vi.fn();
    const outcome = await signOut({ endSession: vi.fn().mockRejectedValue(new Error("Network Error")), clearLocal });
    expect(outcome).toBe("unconfirmed");
    expect(clearLocal).toHaveBeenCalledTimes(1);
  });

  it("clears local state only after the server has answered, so the request still carries its token", async () => {
    const order: string[] = [];
    await signOut({
      endSession: async () => {
        order.push("server");
      },
      clearLocal: () => order.push("local")
    });
    expect(order).toEqual(["server", "local"]);
  });
});
