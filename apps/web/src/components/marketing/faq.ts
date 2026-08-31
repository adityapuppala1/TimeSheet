/**
 * The public answers — the questions a prospect actually asks, and the answers we stand behind.
 *
 * WHY THIS IS A MODULE AND NOT AN ARRAY INSIDE Landing.tsx, where it lived until 4.0.0. The contact
 * page has to reassure an enterprise buyer about exactly three of these — where the data sits,
 * whether AI can be switched off entirely, and whether it runs on their own infrastructure — and
 * the tempting thing is to write a shorter version of each in the second place. Two versions of a
 * promise is one version that will eventually be wrong: somebody softens a sentence on the landing
 * page and the contact page keeps making the stronger claim, or the reverse. The claim is written
 * once, here, and both pages render the same characters.
 *
 * `id` exists so a second surface can name the ones it wants without matching on question text —
 * which would break the moment a question is rephrased, silently, by rendering nothing.
 *
 * A PLAIN `.ts` FILE, deliberately: importing this from Landing.tsx would drag the entire landing
 * chunk (the WebGL backdrop, the pricing and deployment dialogs, every screenshot) into any page
 * that only wanted three paragraphs of text.
 */
export interface FaqEntry {
  id: string;
  q: string;
  a: string;
}

export const FAQ: FaqEntry[] = [
  {
    id: "ai-cost",
    q: "Do you charge for AI usage?",
    a: "No. You bring your own provider key and pay that provider directly. We never resell inference, and the monthly budget cap is enforced on every call so a misconfigured automation can't run up a bill."
  },
  {
    id: "data-residency",
    q: "Does anything leave our servers?",
    a: "AI prompts go to whichever provider you configured, and nowhere else. Face verification is the strict exception: images and embeddings never leave your server at all, and the AI features that touch identity review are sent metadata only — never a face."
  },
  {
    id: "ai-off",
    q: "Can we turn AI off entirely?",
    a: "Yes, and it ships that way. There's a master switch plus a toggle per capability, all off by default. With them off, the app never contacts a model."
  },
  {
    id: "ai-authority",
    q: "What can the AI actually change on its own?",
    a: "Only what you grant per capability, on a ladder — observe, propose, or apply — and a run that reads text from outside the workspace (an email, a chat message, a scanner finding) drops to proposing for the rest of that run. Every change lands as a reviewable row with undo, on the same audit ledger as human work, under the teammate's own name."
  },
  {
    id: "vs-jira",
    q: "How is this different from Jira plus a timesheet tool?",
    a: "The hours and the tickets are the same records, so approvals, SLA timers, cost and attestations all read from one source. You don't reconcile two systems, and a client-facing proof of work doesn't require exporting from both."
  },
  {
    id: "self-host",
    q: "Can we run it on our own infrastructure?",
    a: "Yes. The same codebase deploys as a single-organization on-premise install or as multi-organization SaaS — Docker Compose with overlays for an external database and HTTPS, or a Helm chart with autoscaling. Nothing calls home: your AI key, your OAuth apps, your database."
  },
  {
    id: "outage",
    q: "What happens when the backend goes down?",
    a: "The app notices and says so. One dropped request shows a warning strip; a sustained outage pauses the interface rather than accepting input that would be silently lost. It resumes on its own, without a reload, and keeps what you had typed."
  }
];

/** The entries a surface asked for, in the order it asked for them. Unknown ids are dropped rather
 *  than rendered as a hole, so a renamed id degrades to a shorter list instead of a broken page. */
export const faqEntries = (...ids: string[]): FaqEntry[] => ids.map((id) => FAQ.find((entry) => entry.id === id)).filter((entry): entry is FaqEntry => Boolean(entry));
