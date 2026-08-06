/**
 * WHAT: the current user's own profile page — edit name/bio/avatar, change password, view and
 * revoke active sessions/devices, "sign out everywhere," delete account.
 * WHY sessions are listed here: `store/auth.ts`'s in-memory-only access token means the only
 * durable record of "which devices are logged in" is the `Session` table server-side — this
 * page is the user-facing view of exactly that table (their own rows only).
 * WHO calls the backing API: `controllers/auth.controller.ts`'s `/me`, `/sessions`,
 * `/change-password`, `/avatar` routes.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/min";
import { Camera, ImageOff, KeyRound, Laptop, Loader2, LogOut, Save, Shield, ShieldCheck, Smartphone, Tablet, Trash2, UserRound } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "../components/ui/alert-dialog";
import { FaceEnrollmentCard } from "../components/FaceEnrollmentCard";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { DataTable } from "../components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Separator } from "../components/ui/separator";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";
import { parseUserAgent } from "../lib/user-agent";
import { authApi, fileUrl, type SessionRow } from "../services/api";
import { useAuthStore } from "../store/auth";

const DEVICE_ICON = { desktop: Laptop, mobile: Smartphone, tablet: Tablet } as const;

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif"];
const MAX_AVATAR_MB = 5;

/** Every country libphonenumber knows, named in English and sorted for the picker — built once
 *  at module load, not per render. */
const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
const COUNTRY_OPTIONS = getCountries()
  .map((code) => ({ code, name: REGION_NAMES.of(code) ?? code, dial: `+${getCountryCallingCode(code)}` }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** The browser's own region (from its locale), falling back to India — the deployment default
 *  timezone's country — when the locale carries no region. A default, never a restriction. */
function detectDeviceCountry(): CountryCode {
  const region = new Intl.Locale(navigator.language).region;
  const known = getCountries();
  return region && (known as string[]).includes(region) ? (region as CountryCode) : "IN";
}

/** The device's own IANA timezone — what "auto-detect" means, and the value backfilled for
 *  users who never chose one. */
const DEVICE_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TIMEZONE_OPTIONS = Intl.supportedValuesOf("timeZone");

function initialsFor(name?: string) {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function Profile() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  const [name, setName] = useState(user?.name ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  // Phone lives as country + national number in the UI, and only ever leaves as validated
  // E.164 — the stored value parses back into both fields, so round-trips are lossless.
  const stored = user?.phoneNumber ? parsePhoneNumberFromString(user.phoneNumber) : undefined;
  const [phoneCountry, setPhoneCountry] = useState<CountryCode>(stored?.country ?? detectDeviceCountry());
  const [phoneNational, setPhoneNational] = useState(stored?.nationalNumber ?? "");
  const [timezone, setTimezone] = useState(user?.timezone ?? "");

  /** Empty is fine (the field is optional); anything typed must validate for its country. */
  const phoneParsed = phoneNational.trim() ? parsePhoneNumberFromString(phoneNational, phoneCountry) : undefined;
  const phoneValid = !phoneNational.trim() || (phoneParsed?.isValid() ?? false);
  const phoneE164 = phoneNational.trim() && phoneParsed?.isValid() ? phoneParsed.number : null;
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmRemoveAvatar, setConfirmRemoveAvatar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const profileMutation = useMutation({
    mutationFn: () =>
      authApi.updateProfile({
        name: name.trim(),
        bio: bio.trim() ? bio.trim() : null,
        phoneNumber: phoneE164,
        timezone: timezone.trim() ? timezone.trim() : null
      }),
    onSuccess: (updated) => {
      setUser(updated);
      toast.success("Profile updated", { description: "Visible across audit logs, approvals, and your team page." });
    },
    onError: (err: any) =>
      toast.error("Could not save profile", { description: err?.response?.data?.message ?? "Try again." })
  });

  const avatarMutation = useMutation({
    mutationFn: (file: File) => authApi.uploadAvatar(file),
    onSuccess: (updated) => {
      setUser(updated);
      queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.success("Photo updated", { description: "Your new picture shows up across the workspace." });
    },
    onError: (err: any) =>
      toast.error("Avatar upload failed", {
        description: err?.response?.data?.message ?? "Use a PNG, JPG, JPEG, or GIF under 5 MB."
      })
  });

  const removeAvatarMutation = useMutation({
    mutationFn: () => authApi.removeAvatar(),
    onSuccess: (updated) => {
      setUser(updated);
      queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.success("Avatar removed");
    },
    onError: (err: any) => toast.error("Could not remove avatar", { description: err?.response?.data?.message ?? "Try again." }),
    onSettled: () => setConfirmRemoveAvatar(false)
  });

  const passwordMutation = useMutation({
    mutationFn: () => authApi.changePassword(currentPassword, nextPassword),
    onSuccess: async () => {
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      toast.success("Password updated", { description: "Every other device was signed out for safety." });
      queryClient.invalidateQueries({ queryKey: ["auth", "sessions"] });
      // The server just cleared mustChangePassword — refresh the stored profile so the
      // "choose your own password" banner disappears without a reload.
      try {
        setUser(await authApi.me());
      } catch {
        /* banner clears on next refresh instead */
      }
    },
    onError: (err: any) =>
      toast.error("Could not update password", {
        description: err?.response?.data?.message ?? "Check your current password and try again."
      })
  });

  const sessionsQuery = useQuery({ queryKey: ["auth", "sessions"], queryFn: () => authApi.sessions() });

  const revokeSessionMutation = useMutation({
    mutationFn: (id: string) => authApi.revokeSession(id),
    onSuccess: () => {
      toast.success("Session signed out");
      queryClient.invalidateQueries({ queryKey: ["auth", "sessions"] });
    },
    onError: (err: any) => toast.error("Could not sign out that session", { description: err?.response?.data?.message ?? "Try again." })
  });

  const sessionColumns = useMemo<ColumnDef<SessionRow, any>[]>(
    () => [
      {
        id: "device",
        accessorFn: (row) => parseUserAgent(row.userAgent).browser,
        header: "Device",
        cell: ({ row }) => {
          const { browser, os, deviceType } = parseUserAgent(row.original.userAgent);
          const DeviceIcon = DEVICE_ICON[deviceType];
          return (
            <div className="flex items-center gap-2">
              <DeviceIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {browser} on {os}
                </p>
                {row.original.current && <Badge variant="info" className="mt-0.5">This device</Badge>}
              </div>
            </div>
          );
        }
      },
      {
        id: "ipAddress",
        accessorFn: (row) => row.ipAddress ?? "Unknown IP",
        header: "IP address",
        cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.ipAddress ?? "Unknown IP"}</span>
      },
      {
        id: "signedIn",
        accessorFn: (row) => row.createdAt,
        header: "Signed in",
        cell: ({ row }) => <span className="text-xs text-muted-foreground">{new Date(row.original.createdAt).toLocaleString()}</span>
      },
      {
        id: "expires",
        accessorFn: (row) => row.expiresAt,
        header: "Expires",
        cell: ({ row }) => <span className="text-xs text-muted-foreground">{new Date(row.original.expiresAt).toLocaleString()}</span>
      },
      {
        id: "actions",
        header: () => <span className="block text-right">Actions</span>,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.current ? (
            <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
              <Shield className="h-3.5 w-3.5" />Current session
            </div>
          ) : (
            <div className="text-right">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => revokeSessionMutation.mutate(row.original.id)}
                disabled={revokeSessionMutation.isPending}
              >
                Sign out
              </Button>
            </div>
          )
      }
    ],
    [revokeSessionMutation]
  );

  const logoutAllMutation = useMutation({
    mutationFn: () => authApi.logoutAll(),
    onSuccess: () => {
      globalThis.location.href = "/login";
    },
    onError: (err: any) => toast.error("Could not sign out everywhere", { description: err?.response?.data?.message ?? "Try again." })
  });

  const passwordMismatch = nextPassword.length > 0 && nextPassword !== confirmPassword;

  const profileDirty = useMemo(() => {
    return (
      (name.trim() !== (user?.name ?? "")) ||
      ((bio.trim() || null) !== (user?.bio ?? null)) ||
      (phoneE164 !== (user?.phoneNumber ?? null)) ||
      ((timezone.trim() || null) !== (user?.timezone ?? null))
    );
  }, [name, bio, phoneE164, timezone, user]);

  function pickAvatar() {
    fileInputRef.current?.click();
  }

  function handleAvatarFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast.error("Unsupported image", { description: "PNG, JPG, JPEG, or GIF only." });
      return;
    }
    if (file.size > MAX_AVATAR_MB * 1024 * 1024) {
      toast.error("Image too large", { description: `Keep it under ${MAX_AVATAR_MB} MB.` });
      return;
    }
    avatarMutation.mutate(file);
  }

  const avatarSrc = fileUrl(user?.avatarUrl);
  const bioCount = bio.trim().length;

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight">My profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Update your photo, bio, contact info, and credentials. Changes apply immediately.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <Camera className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>Profile photo</CardTitle>
              <CardDescription>PNG, JPG, JPEG, or GIF. Square images work best. Up to {MAX_AVATAR_MB} MB.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-5">
            <div className="relative">
              <Avatar className="h-24 w-24 ring-2 ring-border">
                {avatarSrc ? <AvatarImage src={avatarSrc} alt={user?.name ?? "Profile photo"} /> : null}
                <AvatarFallback className="text-2xl">{initialsFor(user?.name)}</AvatarFallback>
              </Avatar>
              {avatarMutation.isPending && (
                <div className="absolute inset-0 grid place-items-center rounded-full bg-background/70 backdrop-blur-sm">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              )}
            </div>
            <div className="grid gap-2">
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={pickAvatar} disabled={avatarMutation.isPending}>
                  <Camera className="h-4 w-4" />Upload photo
                </Button>
                {user?.avatarUrl && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setConfirmRemoveAvatar(true)}
                    disabled={removeAvatarMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4" />Remove
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">Your photo appears in the sidebar, top bar, audit log, and team pages.</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".png,.jpg,.jpeg,.gif,image/png,image/jpeg,image/jpg,image/gif"
                className="hidden"
                onChange={handleAvatarFile}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
                <UserRound className="h-5 w-5" />
              </div>
              <div>
                <CardTitle>About you</CardTitle>
                <CardDescription>What your teammates see on hover, approvals, and audit trails.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim().length >= 2 && profileDirty && phoneValid) profileMutation.mutate();
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="profile-name">Display name</Label>
                <Input id="profile-name" value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="profile-email">Email</Label>
                <Input id="profile-email" value={user?.email ?? ""} disabled />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="profile-bio" className="flex items-center justify-between">
                  <span>Bio</span>
                  <span className={`text-xs font-normal ${bioCount > 600 ? "text-destructive" : "text-muted-foreground"}`}>
                    {bioCount} / 600
                  </span>
                </Label>
                <Textarea
                  id="profile-bio"
                  rows={4}
                  value={bio}
                  onChange={(event) => setBio(event.target.value)}
                  maxLength={600}
                  placeholder="A line or two about your role, the projects you own, or how teammates should reach you."
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="profile-phone">Phone</Label>
                  <div className="flex gap-2">
                    {/* Country first, number second — the country picks the validation rules,
                        so "is this number valid" always has a defined answer. */}
                    <Select value={phoneCountry} onValueChange={(v) => setPhoneCountry(v as CountryCode)}>
                      <SelectTrigger className="w-[8.5rem] shrink-0" aria-label="Country code">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        {COUNTRY_OPTIONS.map((c) => (
                          <SelectItem key={c.code} value={c.code}>
                            {c.code} {c.dial}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      id="profile-phone"
                      className="min-w-0 flex-1"
                      value={phoneNational}
                      onChange={(event) => setPhoneNational(event.target.value.replace(/[^\d\s().-]/g, ""))}
                      maxLength={20}
                      inputMode="tel"
                      placeholder={phoneCountry === "IN" ? "98765 43210" : "phone number"}
                      aria-invalid={!phoneValid}
                    />
                  </div>
                  {!phoneValid && (
                    <p className="text-xs text-destructive">
                      Not a valid {REGION_NAMES.of(phoneCountry)} number — check the digits (saved as{" "}
                      {COUNTRY_OPTIONS.find((c) => c.code === phoneCountry)?.dial}…).
                    </p>
                  )}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="profile-tz">Timezone</Label>
                  <div className="flex gap-2">
                    <Select value={timezone || DEVICE_TIMEZONE} onValueChange={setTimezone}>
                      <SelectTrigger id="profile-tz" className="min-w-0 flex-1">
                        <SelectValue placeholder="Pick a timezone" />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        {TIMEZONE_OPTIONS.map((tz) => (
                          <SelectItem key={tz} value={tz}>
                            {tz}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {timezone !== DEVICE_TIMEZONE && (
                      <Button type="button" variant="outline" className="shrink-0" onClick={() => setTimezone(DEVICE_TIMEZONE)}>
                        Use device
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Your device reports <span className="font-medium">{DEVICE_TIMEZONE}</span> — detected from the
                    browser, not from where the server runs.
                  </p>
                </div>
              </div>
              <Separator />
              <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                <span>Role</span>
                <span className="inline-flex items-center gap-1 font-semibold text-foreground">
                  <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                  {user?.role}
                </span>
              </div>
              {user?.manager && (
                <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                  <span>Reports to</span>
                  <span className="font-semibold text-foreground">{user.manager.name}</span>
                </div>
              )}
              <Button
                type="submit"
                disabled={profileMutation.isPending || name.trim().length < 2 || !profileDirty}
              >
                {profileMutation.isPending ? "Saving..." : (<><Save className="h-4 w-4" />Save profile</>)}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-lg bg-warning/10 text-warning">
                <KeyRound className="h-5 w-5" />
              </div>
              <div>
                <CardTitle>Change password</CardTitle>
                <CardDescription>Use at least 8 characters. Active sessions stay valid.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!passwordMismatch && nextPassword.length >= 8) passwordMutation.mutate();
              }}
            >
              <div className="grid gap-1.5">
                <Label>Current password</Label>
                <Input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} minLength={8} />
              </div>
              <div className="grid gap-1.5">
                <Label>New password</Label>
                <Input type="password" value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} minLength={8} />
              </div>
              <div className="grid gap-1.5">
                <Label>Confirm new password</Label>
                <Input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} />
              </div>
              {passwordMismatch && (
                <Alert variant="warning">
                  <AlertTitle>Passwords don't match yet</AlertTitle>
                  <AlertDescription>Re-type the new password to confirm.</AlertDescription>
                </Alert>
              )}
              <Button
                type="submit"
                disabled={
                  passwordMutation.isPending ||
                  passwordMismatch ||
                  nextPassword.length < 8 ||
                  currentPassword.length < 8
                }
              >
                {passwordMutation.isPending ? "Updating..." : "Update password"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
                <Laptop className="h-5 w-5" />
              </div>
              <div>
                <CardTitle>Active sessions</CardTitle>
                <CardDescription>Every device currently signed in to your account.</CardDescription>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => logoutAllMutation.mutate()}
              disabled={logoutAllMutation.isPending}
            >
              <LogOut className="h-4 w-4" />Sign out everywhere
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={sessionColumns}
            data={sessionsQuery.data ?? []}
            isLoading={sessionsQuery.isLoading}
            searchPlaceholder="Search sessions..."
            emptyMessage="No active sessions found."
            pageSize={10}
          />
        </CardContent>
      </Card>

      {/* Renders nothing unless the workspace has face verification enabled and this user is
          covered by it — see FaceEnrollmentCard. */}
      <FaceEnrollmentCard />

      <AlertDialog open={confirmRemoveAvatar} onOpenChange={setConfirmRemoveAvatar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove your photo?</AlertDialogTitle>
            <AlertDialogDescription>
              <ImageOff className="mr-1 inline h-4 w-4 align-text-bottom text-muted-foreground" />
              You can upload a new one any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removeAvatarMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:brightness-110"
            >
              Remove photo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
