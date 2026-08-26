/**
 * WHAT: the "review what we found" step of Requirements Studio's PRD/BRD import — the editable
 * list of answers the AI proposed from an uploaded document, plus the questions it says are still
 * open.
 *
 * WHY IT LIVES HERE AND NOT INLINE: three flows reach this exact screen — a first-time import in
 * the New-document dialog (`RequirementsStudio.tsx`), and re-upload / regenerate on an existing
 * document (`RequirementsDocView.tsx`). One copy means the review-and-edit rules can't drift
 * between "importing" and "re-importing", which would be the whole point of the human-in-the-loop
 * gate quietly weakening in one of them.
 *
 * Purely presentational: the parent owns the rows, the mutations, and the confirm/cancel actions.
 */
import { X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import type { RequirementsImportProposedTurnRow } from "../../services/api";

/** Matches REQUIREMENTS_SECTIONS in the API's ai.service.ts — the closed set the AI is constrained
 *  to, so an unrecognised tag can only mean the two drifted, which is worth showing rather than
 *  hiding (hence the raw-value fallback). */
export const SECTION_LABELS: Record<string, string> = {
  problem: "Problem",
  goals: "Goals",
  targetUsers: "Target users",
  scope: "Scope",
  features: "Features",
  stakeholders: "Stakeholders",
  constraints: "Constraints",
  budget: "Budget",
  techStack: "Tech stack",
  dependencies: "Dependencies",
  uiUx: "UI/UX",
  architecture: "Architecture",
  modules: "Modules",
  nfr: "Non-functional",
  timeline: "Timeline",
  risks: "Risks",
  successMetrics: "Success metrics"
};

export function SectionTagBadge({ tag, className }: { tag?: string | null; className?: string }) {
  if (!tag) return null;
  return (
    <Badge variant="outline" className={className}>
      {SECTION_LABELS[tag] ?? tag}
    </Badge>
  );
}

const CONFIDENCE_VARIANT: Record<RequirementsImportProposedTurnRow["confidence"], "default" | "secondary" | "outline"> = {
  HIGH: "default",
  MEDIUM: "secondary",
  LOW: "outline"
};

export function ImportReviewPanel({
  rows,
  openQuestions,
  summary,
  truncated,
  onChangeAnswer,
  onRemoveRow
}: {
  rows: RequirementsImportProposedTurnRow[];
  openQuestions: string[];
  summary: string | null;
  truncated: boolean;
  onChangeAnswer: (index: number, answer: string) => void;
  onRemoveRow: (index: number) => void;
}) {
  return (
    <div className="grid max-h-[60vh] gap-4 overflow-y-auto pr-1">
      {summary && <p className="text-sm text-muted-foreground">{summary}</p>}
      {truncated && (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          We could only read part of this file — the rest will be covered by follow-up questions.
        </p>
      )}

      {rows.length === 0 && <p className="text-sm text-muted-foreground">Nothing left to save — remove was used on every row.</p>}
      {rows.map((row, index) => (
        <div key={`${row.sectionTag}-${index}`} className="grid gap-1.5 rounded-md border border-border p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium">{row.question}</p>
            <div className="flex shrink-0 items-center gap-1.5">
              <SectionTagBadge tag={row.sectionTag} className="text-[10px]" />
              <Badge variant={CONFIDENCE_VARIANT[row.confidence]} className="text-[10px]">
                {row.confidence.toLowerCase()} confidence
              </Badge>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onRemoveRow(index)} aria-label="Remove this answer">
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <Textarea value={row.answer} onChange={(e) => onChangeAnswer(index, e.target.value)} rows={2} maxLength={4000} />
        </div>
      ))}

      {openQuestions.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">The interview will ask about these next:</p>
          <ul className="grid gap-1 text-xs text-muted-foreground">
            {openQuestions.map((q) => (
              <li key={q}>• {q}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
