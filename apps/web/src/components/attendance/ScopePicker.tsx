/**
 * 7.0.0 leave policies: who a leave type or holiday calendar applies to — employment types and/or
 * work sites. Nothing ticked on an axis means everyone on that axis. Checkboxes, not a multi-select,
 * so every choice is visible and reachable by keyboard and touch.
 */
import { useQuery } from "@tanstack/react-query";
import { EMPLOYMENT_TYPE_OPTIONS, scopeSummary } from "../../lib/employment-type";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { sitesApi } from "./WorkSites";

export interface ScopeValue {
  scopeEmploymentTypes: string[];
  scopeSiteIds: string[];
}

const toggle = (list: string[], value: string, on: boolean) => (on ? [...new Set([...list, value])] : list.filter((v) => v !== value));

export function ScopePicker({ id, value, onChange, disabled = false, what }: Readonly<{ id: string; value: ScopeValue; onChange: (v: ScopeValue) => void; disabled?: boolean; what: string }>) {
  const sites = useQuery({ queryKey: ["attendance", "admin", "sites"], queryFn: sitesApi.list, retry: false });
  const siteName = (sid: string) => sites.data?.find((s) => s.id === sid)?.name;
  return (
    <fieldset className="grid min-w-0 gap-3 rounded-md border border-border p-3" aria-describedby={`${id}-summary`}>
      <legend className="px-1 text-sm font-medium">Who this {what} applies to</legend>
      <p id={`${id}-summary`} className="text-xs text-muted-foreground">
        {scopeSummary(value.scopeEmploymentTypes, value.scopeSiteIds, siteName)}. Leave an axis empty to include everyone on it.
      </p>
      <div className="grid gap-1.5">
        <span className="text-xs font-semibold text-muted-foreground">Employment types</span>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {EMPLOYMENT_TYPE_OPTIONS.map(([v, label]) => (
            <Label key={v} className="flex min-h-[44px] items-center gap-2 text-sm font-normal sm:min-h-0">
              <Checkbox disabled={disabled} checked={value.scopeEmploymentTypes.includes(v)} onCheckedChange={(on) => onChange({ ...value, scopeEmploymentTypes: toggle(value.scopeEmploymentTypes, v, on === true) })} />
              {label}
            </Label>
          ))}
        </div>
      </div>
      {sites.data && sites.data.length > 0 && (
        <div className="grid gap-1.5">
          <span className="text-xs font-semibold text-muted-foreground">Work sites</span>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {sites.data.map((s) => (
              <Label key={s.id} className="flex min-h-[44px] items-center gap-2 text-sm font-normal sm:min-h-0">
                <Checkbox disabled={disabled} checked={value.scopeSiteIds.includes(s.id)} onCheckedChange={(on) => onChange({ ...value, scopeSiteIds: toggle(value.scopeSiteIds, s.id, on === true) })} />
                {s.name}
              </Label>
            ))}
          </div>
        </div>
      )}
    </fieldset>
  );
}
