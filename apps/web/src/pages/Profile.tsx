import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, ImageOff, KeyRound, Laptop, Loader2, LogOut, Save, ShieldCheck, Trash2, UserRound } from "lucide-react";
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
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Separator } from "../components/ui/separator";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";
import { authApi, fileUrl } from "../services/api";
import { useAuthStore } from "../store/auth";

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif"];
const MAX_AVATAR_MB = 5;

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
  const [phoneNumber, setPhoneNumber] = useState(user?.phoneNumber ?? "");
  const [timezone, setTimezone] = useState(user?.timezone ?? "");
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
        phoneNumber: phoneNumber.trim() ? phoneNumber.trim() : null,
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
    onSuccess: () => {
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      toast.success("Password updated", { description: "Every other device was signed out for safety." });
      queryClient.invalidateQueries({ queryKey: ["auth", "sessions"] });
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
      ((phoneNumber.trim() || null) !== (user?.phoneNumber ?? null)) ||
      ((timezone.trim() || null) !== (user?.timezone ?? null))
    );
  }, [name, bio, phoneNumber, timezone, user]);

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
                if (name.trim().length >= 2 && profileDirty) profileMutation.mutate();
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
                  <Input
                    id="profile-phone"
                    value={phoneNumber}
                    onChange={(event) => setPhoneNumber(event.target.value)}
                    maxLength={40}
                    placeholder="+1 555 0123"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="profile-tz">Timezone</Label>
                  <Input
                    id="profile-tz"
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    maxLength={80}
                    placeholder="America/New_York"
                  />
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
          {sessionsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading sessions...</p>
          ) : sessionsQuery.data && sessionsQuery.data.length > 0 ? (
            <div className="grid gap-2">
              {sessionsQuery.data.map((session) => (
                <div
                  key={session.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {session.userAgent ?? "Unknown device"}
                      {session.current && (
                        <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                          This device
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {session.ipAddress ?? "Unknown IP"} · signed in {new Date(session.createdAt).toLocaleString()}
                    </p>
                  </div>
                  {!session.current && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => revokeSessionMutation.mutate(session.id)}
                      disabled={revokeSessionMutation.isPending}
                    >
                      Sign out
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No active sessions found.</p>
          )}
        </CardContent>
      </Card>

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
