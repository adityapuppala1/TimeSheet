/**
 * WHAT: the public, no-account view of a Verified Work Attestation — what a client sees when they
 * open a share link.
 *
 * WHY it's its own page outside `/app`: the reader has no TimeSphere account and no session. It
 * must render with zero auth, never redirect to login, and never assume the app shell (sidebar,
 * user menu, notification bell) exists. It deliberately does NOT use the authenticated axios
 * instance — a plain `fetch`, because there is no token to send and attaching one would be wrong.
 *
 * WHAT IT SHOWS is decided entirely server-side by the link's scope (see
 * api/src/controllers/attestation-public.controller.ts). This component renders whatever it is
 * given and asks for nothing extra — it must never become the place that decides what a client is
 * allowed to see.
 *
 * Every failure — bad token, expired, revoked, voided — comes back as an identical 404 by design,
 * so this page shows one generic "not valid" state rather than leaking which case applied.
 */
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileText, ShieldCheck } from "lucide-react";
import { useParams } from "react-router";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { SERVER_ORIGIN } from "../services/api";

interface PublicAttestation {
  scope: "SUMMARY" | "FULL";
  status: "ISSUED" | "VOID";
  payloadHash: string;
  attestation: {
    reference: string;
    generatedAt: string;
    generatedBy: string | null;
    project: { code: string; name: string; clientName: string | null };
    period: { start: string; end: string };
    currency: string;
  };
  summary: {
    totalHours: number;
    billableHours: number;
    unratedHours: number;
    totalAmount: number;
    entryCount: number;
    contributorCount: number;
    identityVerifiedEntries: number;
    approvedEntries: number;
  };
  workItems: Array<{
    ticketKey: string | null;
    ticketTitle: string;
    hours: number;
    amount: number;
    entries?: Array<{ workDate: string; hours: number; person: string; task: string; identityVerified: boolean }>;
  }>;
  approvals: Array<{ approver: string; entries: number; identityVerified: boolean }>;
  caveats: string[];
}

export function SharedAttestation() {
  const { token } = useParams<{ token: string }>();

  const query = useQuery({
    queryKey: ["shared-attestation", token],
    // Plain fetch, not the app's axios instance: there is no session here by design.
    queryFn: async (): Promise<PublicAttestation> => {
      const res = await fetch(`${SERVER_ORIGIN}/api/shared/attestations/${token}`);
      if (!res.ok) throw new Error("not-valid");
      return res.json();
    },
    enabled: Boolean(token),
    retry: false
  });

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-5 px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-black tracking-tight sm:text-2xl">Verified work attestation</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">A record of approved, identity-verified work.</p>
        </div>
      </div>

      {query.isLoading && <Skeleton className="h-64 w-full" />}

      {query.isError && (
        <Card>
          <CardContent className="grid gap-2 py-10 text-center">
            <p className="text-base font-semibold">This link is not valid</p>
            <p className="text-sm text-muted-foreground">
              It may have expired, been revoked, or never existed. Ask whoever sent it for a fresh link.
            </p>
          </CardContent>
        </Card>
      )}

      {query.data && (
        <>
          {query.data.status === "VOID" && (
            <Card className="border-destructive/40 bg-destructive/5">
              <CardContent className="py-4 text-sm font-medium text-destructive">
                This attestation has been withdrawn by the issuer and should not be relied upon.
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-4 w-4 text-primary" />
                {query.data.attestation.project.code} — {query.data.attestation.project.name}
              </CardTitle>
              <CardDescription>
                {query.data.attestation.project.clientName && <>Prepared for {query.data.attestation.project.clientName}. </>}
                Covering {query.data.attestation.period.start} to {query.data.attestation.period.end}.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4">
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs uppercase text-muted-foreground">Approved entries</p>
                  <p className="mt-1 text-xl font-black">{query.data.summary.entryCount}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs uppercase text-muted-foreground">Total hours</p>
                  <p className="mt-1 text-xl font-black">{query.data.summary.totalHours.toFixed(2)}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs uppercase text-muted-foreground">Amount</p>
                  <p className="mt-1 text-xl font-black">
                    {query.data.summary.totalAmount.toFixed(2)} {query.data.attestation.currency}
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs uppercase text-muted-foreground">Identity verified</p>
                  <p className="mt-1 text-xl font-black">
                    {query.data.summary.identityVerifiedEntries}/{query.data.summary.entryCount}
                  </p>
                </div>
              </div>

              {query.data.summary.identityVerifiedEntries > 0 && (
                <p className="flex items-start gap-2 rounded-md border border-success/30 bg-success/5 p-3 text-sm">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  <span>
                    {query.data.summary.identityVerifiedEntries} of {query.data.summary.entryCount} entries were submitted with a
                    live biometric identity check confirming the person logging the work was the account holder.
                  </span>
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Work</CardTitle>
              <CardDescription>Approved hours grouped by the ticket they were logged against.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-1.5">
              {query.data.workItems.length === 0 && <p className="py-3 text-sm text-muted-foreground">No work items in this period.</p>}
              {query.data.workItems.map((item, i) => (
                <div key={i} className="grid gap-1 rounded-md border border-border px-3 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    {item.ticketKey && <span className="font-mono text-xs text-muted-foreground">{item.ticketKey}</span>}
                    <span className="min-w-0 flex-1 truncate font-medium">{item.ticketTitle}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {item.hours.toFixed(2)}h · {item.amount.toFixed(2)} {query.data!.attestation.currency}
                    </span>
                  </div>
                  {/* Only present on FULL-scope links — SUMMARY withholds per-person rows entirely. */}
                  {item.entries?.map((entry, j) => (
                    <div key={j} className="flex flex-wrap items-center gap-2 pl-3 text-xs text-muted-foreground">
                      <span>{entry.workDate}</span>
                      <span>{entry.person}</span>
                      <span>{entry.hours.toFixed(2)}h</span>
                      {entry.identityVerified && <Badge variant="success" className="text-[10px]">verified</Badge>}
                    </div>
                  ))}
                </div>
              ))}
            </CardContent>
          </Card>

          {query.data.approvals.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Approvals</CardTitle>
                <CardDescription>Who accepted this work internally before it was attested to.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-1.5">
                {query.data.approvals.map((ap, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                    <span className="font-medium">{ap.approver}</span>
                    <span className="text-muted-foreground">
                      {ap.entries} entr{ap.entries === 1 ? "y" : "ies"}
                    </span>
                    {ap.identityVerified && <Badge variant="success">identity verified at approval</Badge>}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {query.data.caveats.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-1.5 text-sm text-muted-foreground">
                  {query.data.caveats.map((c, i) => <li key={i}>• {c}</li>)}
                </ul>
              </CardContent>
            </Card>
          )}

          <p className="break-all text-center text-xs text-muted-foreground">
            Reference {query.data.attestation.reference} · issued{" "}
            {new Date(query.data.attestation.generatedAt).toLocaleString()}
            <br />
            Integrity hash (SHA-256): {query.data.payloadHash}
          </p>
        </>
      )}
    </div>
  );
}
