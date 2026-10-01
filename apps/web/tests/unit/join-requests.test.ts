/**
 * The Requests tab's small decisions, pinned because each one is what an admin acts on:
 *  - the seat line says what approving costs, and says plainly when there is nothing left;
 *  - "expires in" counts down to the server's expiry and never shows a negative number;
 *  - the role picker offers more than EMPLOYEE only to a super admin (the server enforces it too);
 *  - a 402 from approve is told as "out of seats", not as a generic failure.
 */
import { UNLIMITED_SEATS } from "@timesheet/shared";
import { describe, expect, it } from "vitest";
import { approveErrorMessage, expiresInLabel, grantableRoles, seatLine } from "../../src/utils/join-requests";

const now = new Date("2026-10-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("seatLine", () => {
  it("says what one approval uses, and what stays free", () => {
    expect(seatLine(10, 3)).toEqual({ text: "Uses 1 of 10 seats (7 free)", full: false });
    expect(seatLine(10, 9)).toEqual({ text: "Uses 1 of 10 seats (the last free one)", full: false });
  });

  it("does not print the unlimited sentinel as a number", () => {
    expect(seatLine(UNLIMITED_SEATS, 12)).toEqual({ text: "Uses 1 seat — this plan has no seat limit", full: false });
  });

  it("says plainly when the plan is out of seats", () => {
    expect(seatLine(10, 10)).toEqual({ text: "Your plan is out of seats — upgrade or free one first", full: true });
    expect(seatLine(10, 12).full).toBe(true);
  });
});

describe("expiresInLabel", () => {
  it("counts days, then hours, then says expired", () => {
    expect(expiresInLabel(new Date(now.getTime() + 13 * DAY + 60_000).toISOString(), now)).toBe("in 13 days");
    expect(expiresInLabel(new Date(now.getTime() + DAY + 60_000).toISOString(), now)).toBe("in 1 day");
    expect(expiresInLabel(new Date(now.getTime() + 5 * 60 * 60 * 1000).toISOString(), now)).toBe("in 5 hours");
    expect(expiresInLabel(new Date(now.getTime() + 20 * 60 * 1000).toISOString(), now)).toBe("within the hour");
    expect(expiresInLabel(new Date(now.getTime() - 1000).toISOString(), now)).toBe("expired");
  });
});

describe("grantableRoles", () => {
  it("is EMPLOYEE alone for anyone but a super admin", () => {
    expect(grantableRoles("ADMIN")).toEqual(["EMPLOYEE"]);
    expect(grantableRoles(undefined)).toEqual(["EMPLOYEE"]);
  });

  it("is every role for a super admin, EMPLOYEE first", () => {
    expect(grantableRoles("SUPER_ADMIN")[0]).toBe("EMPLOYEE");
    expect(grantableRoles("SUPER_ADMIN")).toEqual(expect.arrayContaining(["EMPLOYEE", "TEAM_LEAD", "MANAGER", "ADMIN", "SUPER_ADMIN"]));
  });
});

describe("approveErrorMessage", () => {
  it("names the seat problem for a 402", () => {
    expect(approveErrorMessage({ response: { status: 402, data: { message: "Seat limit reached (10 seats)." } } })).toEqual({
      text: "Your plan is out of seats — upgrade or free one.",
      billing: true
    });
  });

  it("passes any other server message through", () => {
    expect(approveErrorMessage({ response: { status: 409, data: { message: "This request expired." } } })).toEqual({ text: "This request expired.", billing: false });
    expect(approveErrorMessage(new Error("offline"))).toEqual({ text: "Couldn't approve the request. Try again.", billing: false });
  });
});
