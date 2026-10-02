/**
 * Every change link opens the change.
 *
 * THE DEFECT: the approval email's button and both bell notifications linked to
 * `/app/changes?open=<id>`. The change list never read `?open=`, so an approver who clicked
 * "Approval needed: CHG-x" landed on the unfiltered list and had to go looking for the change they
 * were asked to decide. The change page is a real route, `/app/changes/:id`; the links now go there.
 * (Links already sent keep working: the list redirects `?open=<id>` to the same route.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn(async () => undefined);
const dispatchNotification = vi.fn(async () => undefined);
const renderEmailTemplate = vi.fn(async (_key: string, vars: Record<string, unknown>, fallback: { subject: string; html: string }) => ({ ...fallback, vars }));

vi.mock("../../src/services/mail.service.js", () => ({ sendMail: (...a: unknown[]) => sendMail(...(a as [])) }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: (...a: unknown[]) => dispatchNotification(...(a as [])) }));
vi.mock("../../src/services/template-store.service.js", () => ({
  renderEmailTemplate: (...a: unknown[]) => renderEmailTemplate(...(a as [string, Record<string, unknown>, { subject: string; html: string }]))
}));
vi.mock("../../src/services/workspace-directory.service.js", () => ({ tenantBaseUrl: () => "https://acme.timesphere.app" }));
vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async (args: any) =>
        args?.where?.id ? [{ id: "manager-1", name: "Manu Manager", email: "manu@acme.io" }] : [{ email: "sam@acme.io" }]
      )
    }
  }
}));

const { sendChangeDecisionMail, sendChangeSubmittedMail } = await import("../../src/services/change-mail.service.js");

const change = {
  id: "11111111-1111-4111-8111-111111111111",
  changeKey: "HICS-20261002-0001",
  changeKind: "NORMAL",
  riskLevel: "HIGH",
  riskScore: 80,
  justification: "<p>Because</p>",
  plannedStart: null,
  plannedEnd: null,
  ticket: {
    title: "Rotate the TLS certificate",
    description: null,
    project: { name: "HICS" },
    reporter: { id: "requester-1", name: "Riya Requester", email: "riya@acme.io" },
    assignee: null
  }
};

beforeEach(() => vi.clearAllMocks());

describe("the change links people are sent", () => {
  it("opens the change from the approval email's button", async () => {
    await sendChangeSubmittedMail(change, { name: "Riya Requester" }, ["manager-1"]);
    const vars = renderEmailTemplate.mock.calls[0][1];
    expect(vars.appUrl).toBe(`https://acme.timesphere.app/app/changes/${change.id}`);
  });

  it("opens the change from the approver's bell", async () => {
    await sendChangeSubmittedMail(change, { name: "Riya Requester" }, ["manager-1"]);
    expect(dispatchNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: "manager-1", link: `/app/changes/${change.id}` }));
  });

  it("opens the change from the requester's bell when it is decided", async () => {
    await sendChangeDecisionMail(change, { id: "manager-1", name: "Manu Manager" }, "APPROVED", null);
    expect(dispatchNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: "requester-1", link: `/app/changes/${change.id}` }));
  });
});
