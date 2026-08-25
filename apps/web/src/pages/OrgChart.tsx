import { useQuery } from "@tanstack/react-query";
import { Network } from "lucide-react";

import { OrgChartTree } from "../components/OrgChartTree";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { teamApi } from "../services/api";

/**
 * WHAT: the reporting-line diagram, on its own route so everyone can reach it.
 *
 * WHY IT EXISTS SEPARATELY FROM THE TEAM PAGE: the org chart was only rendered inside
 * `pages/Team.tsx`, which is gated on `timesheets:approve` — so an employee or a team lead could
 * not see who reports to whom, even though the data is not sensitive and the endpoint already
 * serves it to them. `GET /team/org-chart` scopes itself by role (privileged roles get the whole
 * company; everyone else gets their own subtree — themselves plus their reports), so opening this
 * page to all authenticated users exposes nothing the server would not already return. The Team
 * page keeps its own copy for approvers; this is the standalone door for everyone else.
 */
export function OrgChartPage() {
  const orgChart = useQuery({ queryKey: ["team", "org-chart"], queryFn: teamApi.orgChart });
  const roots = orgChart.data ?? [];

  return (
    <div className="mx-auto w-full max-w-6xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Network className="h-5 w-5 text-primary" /> Org chart
          </CardTitle>
          <CardDescription>
            Reporting lines, built from each person's assigned manager. You see your own reporting line;
            administrators see the whole company.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {orgChart.isLoading && <Skeleton className="h-64 w-full" />}
          {!orgChart.isLoading && roots.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No reporting-line data yet — once managers are assigned, the chart appears here.
            </p>
          )}
          {!orgChart.isLoading && roots.length > 0 && <OrgChartTree roots={roots} />}
        </CardContent>
      </Card>
    </div>
  );
}
