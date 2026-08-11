/**
 * WHAT: Workspace Settings → Branding. A SUPER_ADMIN uploads their company's logo and, optionally,
 * the name shown beside it, so the product reads as theirs in the sidebar and on the login page.
 *
 * WHY THE PREVIEW SHOWS BOTH THEMES: a logo is usually supplied as one file, and the two places it
 * renders have different backgrounds. A dark-on-transparent mark that looks right in the light
 * theme disappears entirely in the dark one — better to show that here, at upload time, than to
 * let someone discover it from a screenshot a week later.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Skeleton } from "../../components/ui/skeleton";
import { toast } from "../../components/ui/toaster";
import { brandingApi, brandingLogoUrl } from "../../services/api";

export function BrandingSettingsCard() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const branding = useQuery({ queryKey: ["branding"], queryFn: brandingApi.get });
  const [name, setName] = useState("");

  // Seeded from the server once it answers; typing afterwards is never overwritten by a refetch.
  useEffect(() => {
    if (branding.data) setName(branding.data.displayName ?? "");
  }, [branding.data?.displayName]);

  /** Every mutation refreshes the shared ["branding"] key — the sidebar reads the same query, so
   *  a new logo appears there without a reload. */
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["branding"] });

  const upload = useMutation({
    mutationFn: (file: File) => brandingApi.uploadLogo(file),
    onSuccess: () => {
      invalidate();
      toast.success("Logo updated", { description: "It now appears in the sidebar and on the sign-in page." });
    },
    onError: (err: any) =>
      toast.error("Could not upload the logo", {
        description: err?.response?.data?.message ?? "Use a PNG, JPG, JPEG, or GIF under 5 MB."
      })
  });

  const remove = useMutation({
    mutationFn: () => brandingApi.removeLogo(),
    onSuccess: () => {
      invalidate();
      toast.success("Logo removed", { description: "The TimeSphere mark is shown again." });
    },
    onError: (err: any) => toast.error("Could not remove the logo", { description: err?.response?.data?.message ?? "Try again." })
  });

  const saveName = useMutation({
    mutationFn: () => brandingApi.setName(name.trim() || null),
    onSuccess: () => {
      invalidate();
      toast.success("Workspace name saved");
    },
    onError: (err: any) => toast.error("Could not save the name", { description: err?.response?.data?.message ?? "Try again." })
  });

  const logoSrc = brandingLogoUrl(branding.data);
  const nameDirty = name.trim() !== (branding.data?.displayName ?? "");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ImagePlus className="h-4 w-4 text-primary" />
          Branding
        </CardTitle>
        <CardDescription>
          Your company's logo and name, shown in the sidebar and on the sign-in page. Uploaded images are re-encoded
          (metadata stripped) and scaled to fit 512×160 — the shape is preserved, never cropped.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {branding.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="grid gap-2">
              <Label>Logo</Label>
              <div className="grid gap-3 sm:grid-cols-2">
                {/* Explicit backgrounds, not theme tokens: the point is to show the mark against
                    BOTH surfaces at once, whichever theme the admin happens to be using. */}
                {[
                  { key: "light", label: "On light", className: "bg-white" },
                  { key: "dark", label: "On dark", className: "bg-[#0b1120]" }
                ].map((surface) => (
                  <div key={surface.key} className="grid gap-1.5">
                    <p className="text-xs text-muted-foreground">{surface.label}</p>
                    <div className={`grid h-24 place-items-center rounded-lg border border-border p-3 ${surface.className}`}>
                      {logoSrc ? (
                        <img src={logoSrc} alt="Workspace logo" className="max-h-full max-w-full object-contain" />
                      ) : (
                        <span className="grid h-10 w-10 place-items-center rounded-lg bg-primary text-lg font-black text-primary-foreground">
                          T
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    // Reset first: picking the SAME file twice fires no change event otherwise,
                    // so a failed upload could not be retried without choosing something else.
                    event.target.value = "";
                    if (file) upload.mutate(file);
                  }}
                />
                <Button variant="outline" disabled={upload.isPending} onClick={() => fileInputRef.current?.click()}>
                  {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                  {branding.data?.hasLogo ? "Replace logo" : "Upload logo"}
                </Button>
                {branding.data?.hasLogo && (
                  <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
                    <Trash2 className="h-4 w-4" />
                    Remove
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">PNG, JPG, JPEG or GIF · up to 5 MB.</p>
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="branding-name">Workspace name</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="branding-name"
                  value={name}
                  maxLength={60}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="TimeSphere"
                  className="min-w-0 flex-1"
                />
                <Button disabled={!nameDirty || saveName.isPending} onClick={() => saveName.mutate()}>
                  {saveName.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Save
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Leave empty to keep the product name. This changes what people see, not the URL or anything in email
                headers.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
