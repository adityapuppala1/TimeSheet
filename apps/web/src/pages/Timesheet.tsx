/**
 * WHAT: the timesheet entry form — project/module/submodule/activity picker, rich-text task
 * description, optional ticket link, file attachments, save-as-draft or submit-for-approval.
 * WHY `calculateHours` is shared (`@timesheet/shared`): both this form's live "hours worked"
 * preview and the backend's persisted `totalHours` must agree exactly, so the calculation lives
 * in one place both sides import rather than being re-implemented twice and risking drift.
 * WHO calls the backing API: `controllers/timesheet.controller.ts`'s draft/submit routes.
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { activityTypes, calculateHours } from "@timesheet/shared";
import { AlertTriangle, CalendarClock, Eraser, Save, Send, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { FileDropzone } from "../components/ui/file-dropzone";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "../components/ui/form";
import { Input } from "../components/ui/input";
import { Progress } from "../components/ui/progress";
import { RichTextEditor } from "../components/ui/rich-text-editor";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Separator } from "../components/ui/separator";
import { toast } from "../components/ui/toaster";
import { projectApi, ticketApi, timesheetApi } from "../services/api";

const MAX_DAILY_HOURS = 12;
const OPEN_TICKET_STATUSES = "OPEN,IN_PROGRESS,IN_REVIEW,REOPENED";

const schema = z.object({
  projectId: z.string().min(1, "Pick a project"),
  moduleId: z.string().min(1, "Pick a module"),
  submoduleId: z.string().optional(),
  ticketId: z.string().optional(),
  activityType: z.string().min(1, "Pick an activity"),
  taskDescription: z.string().min(10, "At least 10 characters"),
  workDate: z.string().min(1, "Pick a date"),
  startTime: z.string().min(1, "Required"),
  endTime: z.string().min(1, "Required"),
  notes: z.string().optional()
});

type FormData = z.infer<typeof schema>;

function stripHtml(html: string) {
  return html.replace(/<[^>]+>/g, "").trim();
}

export function Timesheet() {
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const projects = useQuery({ queryKey: ["projects"], queryFn: projectApi.list });
  const timesheets = useQuery({ queryKey: ["timesheets"], queryFn: timesheetApi.list });

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      projectId: "",
      moduleId: "",
      submoduleId: "",
      ticketId: "",
      activityType: "Development",
      taskDescription: "",
      notes: "",
      workDate: new Date().toISOString().slice(0, 10),
      startTime: "09:30",
      endTime: "18:00"
    }
  });

  const projectId = form.watch("projectId");
  const moduleId = form.watch("moduleId");
  const start = form.watch("startTime");
  const end = form.watch("endTime");
  const workDate = form.watch("workDate");

  const selectedProject = useMemo(
    () => projects.data?.find((p: any) => p.id === projectId),
    [projects.data, projectId]
  );
  const selectedModule = useMemo(
    () => selectedProject?.modules?.find((m: any) => m.id === moduleId),
    [selectedProject, moduleId]
  );
  const total = calculateHours(start || "00:00", end || "00:00");

  const openTickets = useQuery({
    queryKey: ["tickets", "for-timesheet", projectId],
    queryFn: () => ticketApi.list({ projectId, status: OPEN_TICKET_STATUSES }),
    enabled: Boolean(projectId)
  });

  const dayTotal = useMemo(() => {
    const list = Array.isArray(timesheets.data) ? timesheets.data : [];
    return list
      .filter((row: any) => String(row.workDate).slice(0, 10) === workDate && row.status !== "REJECTED")
      .reduce((sum: number, row: any) => sum + Number(row.totalHours ?? 0), 0);
  }, [timesheets.data, workDate]);

  const projectedDayTotal = dayTotal + total;
  const overCap = projectedDayTotal > MAX_DAILY_HOURS;
  const capPercent = Math.min(100, Math.round((projectedDayTotal / MAX_DAILY_HOURS) * 100));

  const mutation = useMutation({
    mutationFn: ({ values, draft }: { values: FormData; draft: boolean }) => {
      const payload = {
        ...values,
        taskDescription: values.taskDescription, // stays HTML — server keeps as text
        notes: values.notes ?? ""
      };
      if (files.length) {
        const fd = new window.FormData();
        Object.entries(payload).forEach(([key, value]) => fd.append(key, value ?? ""));
        files.forEach((file) => fd.append("attachments", file));
        return timesheetApi.submitForm(fd, draft);
      }
      return timesheetApi.submit(payload, draft);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["timesheets"] });
      setFiles([]);
      form.reset({
        projectId: form.getValues("projectId"),
        moduleId: form.getValues("moduleId"),
        submoduleId: "",
        ticketId: "",
        activityType: "Development",
        taskDescription: "",
        notes: "",
        workDate: new Date().toISOString().slice(0, 10),
        startTime: "09:30",
        endTime: "18:00"
      });
      toast.success(variables.draft ? "Draft saved" : "Timesheet submitted", {
        description: variables.draft
          ? "You can resume editing from History."
          : "Your manager has been notified for approval."
      });
    },
    onError: (error: any) => {
      const message = error?.response?.data?.message ?? "Submission failed. Check required fields, time overlap, and max hours.";
      toast.error("Could not save timesheet", { description: message });
    }
  });

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Timesheet entry</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Capture daily work with hierarchy-aware selects, automatic hour calculation, and rich task notes.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <Form {...form}>
            <form
              className="grid gap-6"
              onSubmit={form.handleSubmit((values) => mutation.mutate({ values, draft: false }))}
            >
              <section className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
                <FormField
                  control={form.control}
                  name="projectId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Project</FormLabel>
                      <Select value={field.value} onValueChange={(v) => { field.onChange(v); form.setValue("moduleId", ""); form.setValue("submoduleId", ""); form.setValue("ticketId", ""); }}>
                        <FormControl>
                          <SelectTrigger><SelectValue placeholder="Select project" /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {projects.data?.map((p: any) => (
                            <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="moduleId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Module</FormLabel>
                      <Select value={field.value} onValueChange={(v) => { field.onChange(v); form.setValue("submoduleId", ""); }} disabled={!selectedProject}>
                        <FormControl>
                          <SelectTrigger><SelectValue placeholder={selectedProject ? "Select module" : "Pick a project first"} /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {selectedProject?.modules?.map((m: any) => (
                            <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="submoduleId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Submodule <span className="text-muted-foreground">(optional)</span></FormLabel>
                      <Select value={field.value || ""} onValueChange={field.onChange} disabled={!selectedModule}>
                        <FormControl>
                          <SelectTrigger><SelectValue placeholder={selectedModule ? "Optional" : "Pick a module first"} /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {selectedModule?.submodules?.map((s: any) => (
                            <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="ticketId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ticket <span className="text-muted-foreground">(optional)</span></FormLabel>
                      <Select value={field.value || ""} onValueChange={field.onChange} disabled={!selectedProject}>
                        <FormControl>
                          <SelectTrigger><SelectValue placeholder={selectedProject ? "Not linked" : "Pick a project first"} /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(openTickets.data ?? []).map((t) => (
                            <SelectItem key={t.id} value={t.id}>{t.key} — {t.title}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>Attribute this entry's hours to a bug or task for effort reporting.</FormDescription>
                    </FormItem>
                  )}
                />
              </section>

              <section className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
                <FormField
                  control={form.control}
                  name="activityType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Activity</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {activityTypes.map((item) => (
                            <SelectItem key={item} value={item}>{item}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="workDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Date</FormLabel>
                      <FormControl>
                        <Input type="date" max={new Date().toISOString().slice(0, 10)} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="startTime"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Start</FormLabel>
                      <FormControl><Input type="time" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="endTime"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>End</FormLabel>
                      <FormControl><Input type="time" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </section>

              <Separator />

              <FormField
                control={form.control}
                name="taskDescription"
                render={({ field }) => {
                  const length = stripHtml(field.value || "").length;
                  return (
                    <FormItem>
                      <FormLabel className="flex items-center justify-between">
                        <span>Task description</span>
                        <span className={`text-xs font-normal ${length < 10 ? "text-destructive" : "text-muted-foreground"}`}>
                          {length} / min 10
                        </span>
                      </FormLabel>
                      <FormControl>
                        <RichTextEditor
                          value={field.value}
                          onChange={field.onChange}
                          placeholder="What did you build, fix, document, or review? Use formatting to keep it scannable."
                          minHeight="min-h-36"
                          ariaLabel="Task description"
                        />
                      </FormControl>
                      <FormDescription>Supports bold, lists, headings, quotes, links — great for handoffs and audit clarity.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />

              <Controller
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Additional notes <span className="text-muted-foreground">(optional)</span></FormLabel>
                    <FormControl>
                      <RichTextEditor
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        placeholder="Blockers, dependencies, follow-ups..."
                        minHeight="min-h-24"
                        ariaLabel="Additional notes"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormItem>
                <FormLabel>Attachments</FormLabel>
                <FileDropzone files={files} onChange={setFiles} maxFiles={8} maxSizeMb={25} />
              </FormItem>

              <Separator />

              <div className="grid gap-4 rounded-lg border border-border bg-muted/40 p-4 md:grid-cols-[1fr_auto] md:items-center">
                <div className="grid gap-2 text-sm">
                  <div className="flex items-center gap-2 font-semibold">
                    <Sparkles className="h-4 w-4 text-primary" />
                    This entry: <span className="text-primary">{total.toFixed(2)}h</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Already logged on <span className="font-semibold text-foreground">{workDate}</span>:{" "}
                    <span className="font-semibold">{dayTotal.toFixed(2)}h</span> · projected total:{" "}
                    <span className={overCap ? "font-bold text-destructive" : "font-semibold text-foreground"}>
                      {projectedDayTotal.toFixed(2)}h
                    </span>{" "}
                    <span className="text-muted-foreground/70">/ {MAX_DAILY_HOURS}h cap</span>
                  </p>
                  <Progress value={capPercent} className={overCap ? "[&>div]:bg-destructive" : ""} />
                </div>
                <div className="flex flex-wrap gap-2 md:justify-end">
                  <Button type="button" variant="ghost" onClick={() => { form.reset(); setFiles([]); toast.info("Form cleared"); }}>
                    <Eraser className="h-4 w-4" />Clear
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={mutation.isPending}
                    onClick={form.handleSubmit((values) => mutation.mutate({ values, draft: true }))}
                  >
                    <Save className="h-4 w-4" />Save draft
                  </Button>
                  <Button disabled={mutation.isPending || overCap || total <= 0}>
                    <Send className="h-4 w-4" />Submit for approval
                  </Button>
                </div>
              </div>

              {overCap && (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertTitle>Daily cap exceeded</AlertTitle>
                  <AlertDescription>
                    You've crossed the {MAX_DAILY_HOURS}-hour daily limit. Split the entry, reduce hours, or pick another date.
                  </AlertDescription>
                </Alert>
              )}

              <Alert variant="info" className="hidden md:flex">
                <CalendarClock />
                <AlertTitle>Tip</AlertTitle>
                <AlertDescription>
                  Use <kbd className="rounded border border-border bg-background px-1 text-[10px]">⌘ K</kbd> anywhere to jump back to this page — or to history, approvals, or reports.
                </AlertDescription>
              </Alert>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
