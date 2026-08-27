/**
 * WHAT: the "Integrations" tab in Workspace Settings.
 *
 * SCIM PROVISIONING USED TO LIVE HERE and now lives in the Single sign-on tab, because it is the
 * same job: an admin connecting Okta points sign-in at the IdP *and* lets the IdP create and close
 * the accounts that sign in. Split across two tabs, the second half was routinely missed. The
 * pointer below stays because an admin who knew where SCIM was should not have to hunt for it —
 * and it moves them there rather than just naming the tab.
 *
 * WHY Calendar sync isn't here yet: it needs the org's own Google/Microsoft OAuth App
 * credentials (same bring-your-own-app-registration model GitConnection uses) — tracked in
 * docs/ROADMAP.md's "Integrations" theme, not built yet.
 */
import { ArrowRight, CalendarClock, UserCog } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";

export function IntegrationsSettingsCard({ readOnly, onGoToSso }: { readOnly: boolean; onGoToSso: () => void }) {
  return (
    <div className="grid gap-5">
      <Card className="overflow-hidden">
        <CardContent className="flex flex-wrap items-center gap-4 pt-6">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <UserCog className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-base">SCIM provisioning moved</CardTitle>
            <CardDescription className="mt-1">
              It now sits with the identity providers it belongs to, under <span className="font-medium text-foreground">Single sign-on</span>.
              Nothing about your configuration changed — the base URL and any token you generated are exactly as you left them.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={onGoToSso}>
            Open Single sign-on
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
            Calendar sync
          </CardTitle>
          <CardDescription>
            Not built yet — needs your own Google/Microsoft OAuth App credentials. Tracked in the roadmap.
            {readOnly ? " You are viewing this read-only." : ""}
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
