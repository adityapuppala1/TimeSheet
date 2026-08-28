/**
 * "Talk to sales" — the three ways an Enterprise customer can actually run TimeSphere, and what
 * genuinely differs between them.
 *
 * WHY THIS EXISTS AS A SCREEN RATHER THAN A MAILTO. The Enterprise CTA used to point at `/login`,
 * which is neither a sales flow nor an honest answer to "how would we run this?". The question a
 * buyer at this tier asks first is not about features — it is *where does our data sit and who
 * holds the keys*, and that has three real answers in this codebase: our cloud, their cloud, or
 * their datacentre. All three run the same images; what changes is who operates them.
 *
 * ACCURACY IS THE HARD CONSTRAINT, exactly as it is for `PricingDialog`. Every row below maps to
 * something that exists: the Helm chart in `deploy/helm/timesphere`, the two compose files, the
 * per-tenant database every plan already gets, the managed-backup destinations in
 * `services/backup-destination.service.ts`, and the entitlements in `PLAN_TIER_LIMITS`. The
 * PRICING is stated as a shape (per seat, per instance, annual licence) rather than as invented
 * numbers, because the numbers are a conversation and a made-up figure on a page is worse than no
 * figure — this file's sibling has a comment about exactly that kind of drift.
 */
import { PLAN_TIER_LIMITS } from "@timesheet/shared";
import { Building2, Check, Cloud, Mail, Minus, ServerCog } from "lucide-react";
import { Fragment } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

type Cell = boolean | string;

interface Model {
  id: "saas" | "your-cloud" | "on-prem";
  name: string;
  icon: typeof Cloud;
  tagline: string;
  /** The SHAPE of the commercial arrangement, never an invented number. */
  pricing: string;
  billed: string;
  highlight?: boolean;
}

const MODELS: Model[] = [
  {
    id: "saas",
    name: "TimeSphere Cloud",
    icon: Cloud,
    tagline: "We run it. You get a workspace on your own subdomain and never think about a server.",
    pricing: "Per seat, per month",
    billed: "Monthly or annually · start today",
    highlight: true
  },
  {
    id: "your-cloud",
    name: "Your own cloud",
    icon: ServerCog,
    tagline: "The same images in your AWS, Azure or GCP account, deployed with our Helm chart.",
    pricing: "Per seat + a platform fee",
    billed: "Annual · your infrastructure costs are yours"
  },
  {
    id: "on-prem",
    name: "On-premises",
    icon: Building2,
    tagline: "In your datacentre, behind your firewall, air-gappable.",
    pricing: "Annual licence, per instance",
    billed: "Annual · unlimited seats, support tiered separately"
  }
];

interface Row {
  label: string;
  hint?: string;
  saas: Cell;
  yourCloud: Cell;
  onPrem: Cell;
}

const GROUPS: Array<{ group: string; rows: Row[] }> = [
  {
    group: "Where things live",
    rows: [
      {
        label: "Who operates the servers",
        saas: "Us",
        yourCloud: "You, with our chart",
        onPrem: "You"
      },
      {
        label: "Where the database sits",
        hint: "Every workspace has its own database on all three — that is architectural, not a plan feature.",
        saas: "Our managed MySQL",
        yourCloud: "Your RDS / Flexible Server / Cloud SQL",
        onPrem: "Your MySQL"
      },
      {
        label: "Who holds the encryption key",
        hint: "Secrets at rest — SSO client secrets, SMTP passwords, backup credentials, tenant DSNs — are AES-256-GCM sealed with ENCRYPTION_KEY.",
        saas: "Us",
        yourCloud: "You",
        onPrem: "You"
      },
      {
        label: "Data residency you choose",
        saas: "Our regions",
        yourCloud: true,
        onPrem: true
      },
      {
        label: "Works with no internet access",
        hint: "AI features need a provider endpoint; everything else runs offline.",
        saas: false,
        yourCloud: false,
        onPrem: true
      }
    ]
  },
  {
    group: "Backups",
    rows: [
      {
        label: "Automatic database backups",
        hint: "Daily on Enterprise, whichever way you run it.",
        saas: "Daily, by us",
        yourCloud: "Daily, to your bucket",
        onPrem: "Daily, to your storage"
      },
      {
        label: "Destinations you control",
        hint: "S3 or any S3-compatible bucket, Azure Blob, Google Drive, OneDrive/SharePoint, or your own SFTP server.",
        saas: `Up to ${PLAN_TIER_LIMITS.ENTERPRISE.maxBackupDestinations}`,
        yourCloud: `Up to ${PLAN_TIER_LIMITS.ENTERPRISE.maxBackupDestinations}`,
        onPrem: `Up to ${PLAN_TIER_LIMITS.ENTERPRISE.maxBackupDestinations}`
      },
      { label: "Test restores + point-in-time recovery", saas: true, yourCloud: true, onPrem: true },
      {
        label: "Backups never leave your network",
        hint: "Only possible where the destination is yours — an SFTP server or a bucket inside your own VPC.",
        saas: false,
        yourCloud: true,
        onPrem: true
      }
    ]
  },
  {
    group: "Operations",
    rows: [
      { label: "Upgrades", saas: "We deploy them", yourCloud: "You, when you choose", onPrem: "You, when you choose" },
      {
        label: "Uptime SLA",
        hint: "We can only promise uptime for infrastructure we operate.",
        saas: "Contractual",
        yourCloud: "Support SLA only",
        onPrem: "Support SLA only"
      },
      { label: "SAML / LDAP / SCIM", saas: true, yourCloud: true, onPrem: true },
      {
        label: "Your own AI provider key",
        hint: "Every plan brings its own key — including a self-hosted Ollama, which is what an air-gapped install uses.",
        saas: true,
        yourCloud: true,
        onPrem: true
      },
      {
        label: "Audit log + change management",
        saas: true,
        yourCloud: true,
        onPrem: true
      }
    ]
  },
  {
    group: "Commercials",
    rows: [
      { label: "How it is priced", saas: "Per seat / month", yourCloud: "Per seat + platform fee", onPrem: "Annual licence per instance" },
      { label: "Minimum term", saas: "None on Cloud; annual on Enterprise", yourCloud: "Annual", onPrem: "Annual" },
      {
        label: "Infrastructure billed by",
        hint: "In the two self-run models you pay your cloud provider directly, and we never mark it up.",
        saas: "Us, included",
        yourCloud: "Your cloud provider",
        onPrem: "You"
      },
      { label: "Procurement paperwork, DPA, security review", saas: true, yourCloud: true, onPrem: true }
    ]
  }
];

function CellValue({ value }: { value: Cell }) {
  if (value === true) {
    return (
      <>
        <Check className="mx-auto h-4 w-4 text-success" aria-hidden />
        <span className="sr-only">Included</span>
      </>
    );
  }
  if (value === false) {
    return (
      <>
        <Minus className="mx-auto h-4 w-4 text-muted-foreground/40" aria-hidden />
        <span className="sr-only">Not available</span>
      </>
    );
  }
  return <span className="text-xs font-medium">{value}</span>;
}

export function DeploymentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Same scroll structure as PricingDialog: ONE container scrolling both ways, so it is the
          sticky header's scrollport. Two nested scrollers is what broke that header before. */}
      <DialogContent className="flex max-h-[92vh] w-[min(96vw,1000px)] max-w-none flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>How would you like to run it?</DialogTitle>
          <DialogDescription>
            Enterprise runs three ways, on the same images. What changes is who operates them, where your data sits, and who holds the
            encryption key. Pricing is stated as a shape rather than a number — the number is part of the conversation.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-2 min-h-0 flex-1 overflow-auto px-2">
          <div className="grid gap-3 pb-4 sm:grid-cols-3">
            {MODELS.map((model) => (
              <div
                key={model.id}
                className={`grid content-start gap-2 rounded-xl border p-4 ${model.highlight ? "border-primary/40 bg-primary/5" : "border-border"}`}
              >
                <span className="flex items-center gap-2">
                  <model.icon className="h-4 w-4 text-primary" aria-hidden />
                  <span className="font-semibold">{model.name}</span>
                  {model.highlight && <Badge variant="info">Most common</Badge>}
                </span>
                <p className="text-xs leading-5 text-muted-foreground">{model.tagline}</p>
                <p className="mt-1 text-sm font-semibold">{model.pricing}</p>
                <p className="text-xs text-muted-foreground">{model.billed}</p>
              </div>
            ))}
          </div>

          <table className="w-full min-w-[680px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-popover">
              <tr className="border-b border-border">
                <th scope="col" className="py-3 pr-3 text-left font-semibold">
                  &nbsp;
                </th>
                <th scope="col" className="w-40 px-2 py-3 text-center font-semibold text-primary">
                  TimeSphere Cloud
                </th>
                <th scope="col" className="w-40 px-2 py-3 text-center font-semibold">
                  Your own cloud
                </th>
                <th scope="col" className="w-40 px-2 py-3 text-center font-semibold">
                  On-premises
                </th>
              </tr>
            </thead>
            <tbody>
              {GROUPS.map(({ group, rows }) => (
                <Fragment key={group}>
                  <tr>
                    <th scope="colgroup" colSpan={4} className="pb-1 pt-5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {group}
                    </th>
                  </tr>
                  {rows.map((row) => (
                    <tr key={row.label} className="border-b border-border/60 last:border-0">
                      <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                        {row.label}
                        {row.hint && <span className="block text-xs text-muted-foreground">{row.hint}</span>}
                      </th>
                      <td className="bg-primary/5 px-2 py-2.5 text-center">
                        <CellValue value={row.saas} />
                      </td>
                      <td className="px-2 py-2.5 text-center">
                        <CellValue value={row.yourCloud} />
                      </td>
                      <td className="px-2 py-2.5 text-center">
                        <CellValue value={row.onPrem} />
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <p className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <Badge variant="muted" className="mr-2 align-middle">
            Note
          </Badge>
          Every model gives each workspace its own database — no organization has ever shared a schema here. AI is always your own
          provider key on all three, so an air-gapped install can point at a self-hosted model and keep working.
        </p>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button asChild className="gap-2">
            {/* A real mailto with the question pre-filled: there is no CRM behind this build, and a
                form that posts nowhere would be worse than an address that works. */}
            <a href="mailto:sales@timesphere.app?subject=TimeSphere%20Enterprise%20enquiry&body=How%20we%27d%20like%20to%20run%20it%3A%20%28Cloud%20%2F%20our%20own%20cloud%20%2F%20on-premises%29%0AApproximate%20seats%3A%0ATimeline%3A%0AAnything%20specific%3A">
              <Mail className="h-4 w-4" aria-hidden />
              Email sales
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
