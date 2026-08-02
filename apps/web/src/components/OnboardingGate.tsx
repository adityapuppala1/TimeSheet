/**
 * WHAT: the first-run gate. A new joiner cannot use the app until they've filled in the profile
 * details the workspace needs and — when the policy covers them — enrolled their face.
 *
 * WHY BLOCK AT ALL, when SetupChecklistCard deliberately doesn't: because the two answer different
 * questions. The checklist nudges an established user toward a nicer profile. This exists so a
 * brand-new account can't start submitting work the workspace can't attribute or verify. Both
 * stay: the gate only ever fires once, and the checklist keeps handling everything after it.
 *
 * THE THING THAT MAKES IT SAFE is on the server (services/onboarding.service.ts): a stored
 * `onboardingCompletedAt`, backfilled for every user that existed when this shipped. Without that
 * backfill, adding this gate would have locked out every current user whose profile happened to
 * be missing a phone number — punishing people for a configuration change they had no part in,
 * which is exactly the objection that kept the checklist non-blocking in the first place.
 *
 * WHY IT ALLOWS /app/profile THROUGH: the whole point is to get the profile filled in, and the
 * profile page is where that happens. Blocking it too would be a locked door with the key inside.
 */
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, ScanFace, UserCog } from "lucide-react";
import { Link, useLocation } from "react-router";
import { authApi } from "../services/api";
import { useAuthStore } from "../store/auth";
import { Button } from "./ui/button";

/** The one route a gated user may still reach — it's where the requirements get satisfied. */
const ESCAPE_HATCH = "/app/profile";

export function OnboardingGate() {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();

  const status = useQuery({
    queryKey: ["auth", "onboarding-status"],
    queryFn: authApi.onboardingStatus,
    enabled: Boolean(user),
    // Refetched on focus and on navigation so finishing enrollment in the profile page lifts the
    // gate without a reload. The server self-closes the gate the moment requirements are met.
    refetchOnWindowFocus: true,
    staleTime: 5_000
  });

  if (!user || !status.data?.blocked) return null;
  // Already where they need to be — show nothing, or they can't reach the fields.
  if (location.pathname.startsWith(ESCAPE_HATCH)) return null;

  const { profile, face } = status.data;
  const steps = [
    {
      key: "profile",
      icon: UserCog,
      label: "Complete your profile",
      detail:
        profile.missing.length > 0
          ? `Still needed: ${profile.missing.map((f) => (f === "phoneNumber" ? "phone number" : "timezone")).join(" and ")}.`
          : "Done.",
      done: profile.complete
    },
    // Only shown when the workspace actually requires it — an org with face verification off must
    // never see this step, let alone be held by it.
    ...(face.required
      ? [
          {
            key: "face",
            icon: ScanFace,
            label: "Enrol your face",
            detail: face.enrolled ? "Done." : "Your workspace requires an identity check before you can submit work.",
            done: face.enrolled
          }
        ]
      : [])
  ];

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="onboarding-gate-title"
      className="fixed inset-0 z-[90] grid place-items-center bg-background/85 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-lg">
        <h2 id="onboarding-gate-title" className="text-lg font-black tracking-tight">
          Finish setting up your account
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Welcome{user.name ? `, ${user.name.split(" ")[0]}` : ""}. A couple of things are needed before you can start —
          it takes about a minute, and you'll only be asked once.
        </p>

        <ul className="mt-5 grid gap-2">
          {steps.map((step) => (
            <li
              key={step.key}
              className={`flex items-start gap-3 rounded-lg border p-3 ${
                step.done ? "border-success/40 bg-success/5" : "border-border"
              }`}
            >
              {step.done ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              ) : (
                <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-semibold">
                  <step.icon className="h-3.5 w-3.5 text-primary" />
                  {step.label}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{step.detail}</p>
              </div>
            </li>
          ))}
        </ul>

        <Button asChild className="mt-5 w-full">
          <Link to={ESCAPE_HATCH}>Go to my profile</Link>
        </Button>
        <p className="mt-3 text-center text-xs text-muted-foreground">
          Stuck? Your workspace admin can help — the requirements are set by them, not by us.
        </p>
      </div>
    </div>
  );
}
