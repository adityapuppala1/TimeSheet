/**
 * The six claims the pitch deck was built on — and, since 11.1, the front page's "Why it stands
 * out" band. ONE list, imported by both, so a claim cannot appear on the landing page that has not
 * been written clause by clause against shipped code for the deck. Adding one means adding it here.
 */
import { Building2, FileCheck2, FlaskConical, GanttChartSquare, Lock, ShieldCheck, Workflow } from "lucide-react";

export const MOATS = [
  {
    icon: GanttChartSquare,
    title: "The only planner that can measure itself",
    body: "Every project tool in this category compares a plan against another plan, because estimates are the only thing it holds. This one owns the approved, rate-snapshotted timesheet too — so the workload board puts planned hours, actually-logged hours and contracted capacity on one axis, and a budget forecast is priced from the same rates a client-facing attestation reads.",
    why: "A planning vendor cannot bolt this on: they would need timesheet capture, an approval chain and rate history in production first. A timesheet vendor has the data and no plan to compare it against. The fusion is the product, and it is only available to whoever owns both halves."
  },
  {
    icon: ShieldCheck,
    title: "The only place a fix can be proven",
    body: "Resolving a ticket that carries security findings records a claim, and the next scan by the same tool on the same repository and branch settles it: gone means verified, stamped with the run and commit that proved it; still there means the ticket reopens with that evidence and everyone who logged time on it hears why. No scan in the window means unverified — and never a reopen, because absence of proof is not proof of failure.",
    why: "No scanner vendor can ship this, and it is not a matter of effort. Proving a fix held requires owning the ticket that claimed it, the timesheet that says who worked on it, the reporting line that decides who to tell, and the module map that routes it — four things a scanner has none of. A scanner can only ever say what it sees today; it cannot say a promise was kept."
  },
  {
    icon: FileCheck2,
    title: "Proof as a first-class output",
    body: "Most tools stop at reporting. This one produces a signed, page-numbered attestation of approved, identity-verified work — with the rate that applied at approval frozen into the record, so a rate change next quarter can't rewrite last quarter's invoice.",
    why: "Competitors would need identity verification, approval workflow and rate history to exist together before they could ship the artefact at all."
  },
  {
    icon: FlaskConical,
    title: "An AI loop that closes",
    body: "Capture what the model was asked and answered, correct real failures into a golden set, version prompts without a deploy, then replay and score. Most products stop at 'we added AI' and collect thumbs-up ratings nothing ever reads.",
    why: "This is infrastructure, not a feature. It's the difference between an AI that's demoed once and one that measurably improves in production."
  },
  {
    icon: Building2,
    title: "The operator's console is part of the product",
    body: "Whoever runs the deployment gets a real control plane, not a spreadsheet and a shell: one maintenance window armed across every workspace — which the workspaces themselves cannot switch off — plus per-tenant database monitoring, a year of growth history, and two guarded operations where a rebuild is refused outside a maintenance window. It now carries its own authority model too: five operator roles read from the database on every request, optional TOTP, a second pair of eyes on the five actions that cannot be undone, and a recorded reason on every sensitive one.",
    why: "Every multi-tenant product eventually needs this and most build it privately, badly, after the first incident. Shipping it means the same install runs as somebody's own on-premise deployment, as our SaaS, and as a partner's — because operating it is a product surface rather than tribal knowledge."
  },
  {
    icon: Lock,
    title: "Bring-your-own-key as the default",
    body: "Every AI capability is off until switched on, and all of them run against the customer's own provider key under a budget the product enforces per call — or against a model their own server runs, where there is no key and no third party at all. We never resell inference.",
    why: "It removes the single most common blocker to AI adoption in a regulated buyer: 'where does our data go, and what will this cost?' Both answers are the customer's own."
  },
  {
    icon: Building2,
    title: "Isolation you can point at",
    body: "A database per organization, not a shared table with a tenant column. There is no query to get wrong, because there is no shared connection for one to cross.",
    why: "It's an architecture decision that's expensive to retrofit. Anyone starting from a shared schema has to rebuild their data layer to match this claim."
  },
  {
    icon: Workflow,
    title: "An agentic layer that adds no new power",
    body: "Teammates and flows compose capabilities that already exist, under the same review, undo and audit path as every other AI change. Switching one on grants nothing new — it only names who runs what, at what budget, with what authority.",
    why: "Most products bolt agents on as a second write-path with its own permissions to audit. Composition means the security review done once covers the agents too — and the same provenance chain explains every run."
  }
];

/** The first sentence of a claim, for the landing page's glance-sized cards. The deck keeps the
 *  whole argument; a front page that repeats it in full is a wall the reader scrolls past. Cuts at
 *  the first sentence end followed by a space, never mid-sentence. */
export function firstSentence(body: string): string {
  const match = /^(.+?[.!?])\s/.exec(body);
  return match ? match[1] : body;
}
