/**
 * The break-glass for a single-owner install (H5): create a second OWNER from the API host's shell.
 *
 * WHY IT EXISTS. A fresh install has exactly one OWNER, and every two-person action — creating an
 * operator included — needs a DIFFERENT owner to approve it. So a new deployment could never approve
 * anything from the console, and the approval queue's own advice ("create a second owner first") had
 * no route that worked. The only way out was SQL against the control database.
 *
 * WHY IT DOES NOT WEAKEN THE TWO-PERSON RULE:
 *  - It refuses as soon as there are TWO active owners. Below that, the console's rule cannot be
 *    satisfied by anybody; at two, the console is the way, and this would only be a second door.
 *  - It needs shell access to the API host, which already holds the control database credentials
 *    and every signing secret — it grants nobody anything they could not already take.
 *  - It is audited (the reason, the host user) and the new owner starts behind the rotation gate,
 *    with a generated password printed once — the same terms as an operator made by approval.
 *
 * The logic lives here so it can be tested; scripts/control-create-owner.ts is a thin wrapper.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { generateTempPassword, hashPassword } from "../utils/security.js";
import { platformAudit } from "./platform-audit.service.js";

const REASON_MIN = 8;

/** One "@", something either side, a dot in the domain, no whitespace. Deliberately not a regex —
 *  the CLI's argument is attacker-adjacent input, and this shape needs no backtracking to check. */
function looksLikeEmail(value: string): boolean {
  const parts = value.split("@");
  if (parts.length !== 2 || /\s/.test(value)) return false;
  const [local, domain] = parts;
  return local.length > 0 && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

export interface BreakGlassOwnerInput {
  email: string;
  name: string;
  reason: string;
  /** Who ran it — `<os user>@<hostname>` from the script. Lands in the audit row. */
  actor: string;
}

export async function createBreakGlassOwner(input: BreakGlassOwnerInput): Promise<{ id: string; email: string; temporaryPassword: string }> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  const reason = input.reason.trim();
  if (!looksLikeEmail(email)) throw new Error(`"${input.email}" is not an email address.`);
  if (name.length < 2) throw new Error("A name of at least 2 characters is required.");
  if (reason.length < REASON_MIN) throw new Error(`A reason of at least ${REASON_MIN} characters is required — it is recorded in the audit trail.`);

  const owners = await controlPrisma.platformAdminUser.count({ where: { status: "ACTIVE", role: "OWNER" } });
  if (owners >= 2) {
    throw new Error(`This deployment already has ${owners} active owners, so the console's two-person rule can be met: create the account from Platform admin → Access and have another owner approve it.`);
  }
  if (await controlPrisma.platformAdminUser.findUnique({ where: { email }, select: { id: true } })) {
    throw new Error(`${email} is already a platform admin account.`);
  }

  const temporaryPassword = generateTempPassword();
  const row = await controlPrisma.platformAdminUser.create({
    data: { email, name, role: "OWNER", status: "ACTIVE", passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true }
  });
  await platformAudit("SYSTEM", `cli:control-create-owner (${input.actor})`, "platform_admin.created_break_glass", "PlatformAdminUser", row.id, {
    email,
    role: "OWNER",
    activeOwnersBefore: owners
  }, { reason, after: { email, role: "OWNER", status: "ACTIVE", mustChangePassword: true } });
  return { id: row.id, email, temporaryPassword };
}
