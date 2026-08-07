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
import { AlertTriangle, CalendarClock, Check, ChevronsUpDown, Eraser, Save, Send, Sparkles, Ticket } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
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
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Separator } from "../components/ui/separator";
import { toast } from "../components/ui/toaster";
import { DatePicker, TimeField } from "../components/ui/date-picker";
import { faceApi, projectApi, ticketApi, timesheetApi, type AIRefineField } from "../services/api";
import { AiRefinePanel, AiRefineTrigger, useAiRefine } from "../components/AiRefine";
import { FaceVerificationDialog } from "../components/FaceVerificationDialog";
import { useFaceStatus } from "../lib/use-face-status";

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

/**
 * Searchable ticket picker — a plain dropdown is fine at 10 tickets and useless at 200, and a
 * busy project easily has 200. Type-ahead filters on key AND title ("OPS-381", "lineage",
 * either works), keyboard-navigable, with an explicit "Not linked" row so clearing the link is
 * a first-class choice rather than a hunt for an empty option.
 */
function TicketPicker({
  tickets,
  value,
  onChange,
  disabled,
  placeholder
}: {
  tickets: Array<{ id: string; key: string; title: string }>;
  value: string;
  onChange: (ticketId: string) => void;
  disabled: boolean;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = tickets.find((ticket) => ticket.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <FormControl>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="w-full justify-between font-normal"
          >
            <span className={`truncate ${selected ? "" : "text-muted-foreground"}`}>
              {selected ? `${selected.key} — ${selected.title}` : placeholder}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </FormControl>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search by key or title…" />
          <CommandList>
            <CommandEmpty>No open tickets match.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__none__ not linked"
                onSelect={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                <Check className={`mr-2 h-4 w-4 ${value === "" ? "opacity-100" : "opacity-0"}`} />
                <span className="text-muted-foreground">Not linked</span>
              </CommandItem>
              {tickets.map((ticket) => (
                <CommandItem
                  key={ticket.id}
                  // cmdk filters on this string — key + title together is what makes both
                  // "OPS-381" and a word from the title find the row.
                  value={`${ticket.key} ${ticket.title}`}
                  onSelect={() => {
                    onChange(ticket.id);
                    setOpen(false);
                  }}
                >
                  <Check className={`mr-2 h-4 w-4 shrink-0 ${value === ticket.id ? "opacity-100" : "opacity-0"}`} />
                  <Ticket className="mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">
                    <span className="font-medium">{ticket.key}</span>
                    <span className="text-muted-foreground"> — {ticket.title}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A rich-text field with the AI refine affordance wired in. Its own component, not an inline
 * fragment, because `useAiRefine` is a hook and react-hook-form's `render` prop is a plain
 * callback — hooks called in there would belong to `FormField`, not to the field.
 *
 * The trigger sits beside the label rather than inside it: `FormLabel` renders a real `<label>`,
 * and a button inside a label is a click that can activate the labelled control instead of itself.
 */
function RefinableRichText({
  refineField,
  refineLabel,
  label,
  value,
  onChange,
  placeholder,
  minHeight,
  ariaLabel,
  meta
}: {
  refineField: AIRefineField;
  refineLabel: string;
  label: React.ReactNode;
  value: string;
  onChange: (html: string) => void;
  placeholder: string;
  minHeight: string;
  ariaLabel: string;
  /** Anything shown at the right of the label row alongside the trigger (e.g. a character count). */
  meta?: React.ReactNode;
}) {
  const refine = useAiRefine({ field: refineField, value, onChange, label: refineLabel });

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <FormLabel>{label}</FormLabel>
        <div className="flex items-center gap-2">
          {meta}
          <AiRefineTrigger state={refine} />
        </div>
      </div>
      <FormControl>
        <RichTextEditor
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          minHeight={minHeight}
          ariaLabel={ariaLabel}
        />
      </FormControl>
      <AiRefinePanel state={refine} />
    </>
  );
}

export function Timesheet() {
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list() });
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

  const formRef = useRef<HTMLFormElement>(null);

  /**
   * Take the user to the first field that failed validation.
   *
   * react-hook-form's built-in `shouldFocusError` only fires for fields it holds a DOM ref for.
   * Every select on this form is a Radix trigger rendered through `<Controller>`, so RHF has no
   * ref for them and a failed submit did nothing the user could see — the offending field is
   * usually scrolled off-screen, so the form just appeared not to respond to the button.
   *
   * Keying off `aria-invalid` (stamped by shadcn's `FormControl` on whichever element is in
   * error) rather than a field-name lookup means this keeps working as fields are added, moved
   * or reordered: the first match in document order IS the first error on screen, with no
   * name -> element map to keep in sync.
   */
  const focusFirstInvalid = useCallback(() => {
    // Next frame: `FormMessage` has to render before we scroll, or we centre the field on its
    // pre-error position and it shifts out from under the user as the message expands.
    requestAnimationFrame(() => {
      const target = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      if (!target) return;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      // preventScroll so focus() doesn't fight the smooth scroll above with a second jump.
      target.focus({ preventScroll: true });

      const label = target.id ? formRef.current?.querySelector(`label[for="${CSS.escape(target.id)}"]`) : null;
      toast.error("Check the highlighted field", {
        description: label?.textContent ? `"${label.textContent.trim()}" needs attention before this can be saved.` : undefined
      });
    });
  }, []);

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
    mutationFn: ({ values, draft, faceVerificationId }: { values: FormData; draft: boolean; faceVerificationId?: string }) => {
      const payload = {
        ...values,
        taskDescription: values.taskDescription, // stays HTML — server keeps as text
        notes: values.notes ?? "",
        // Single-use token proving a live identity check just passed. Only present when the
        // workspace policy covers this user; the server re-checks whether it was required at
        // all, so omitting it can never bypass the gate.
        ...(faceVerificationId ? { faceVerificationId } : {})
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

  // Whether THIS user must pass a face check before submitting. Read from the server rather
  // than assumed, since it depends on the workspace policy plus a per-user override.
  const faceStatus = useFaceStatus();
  const [faceDialogOpen, setFaceDialogOpen] = useState(false);
  const [pendingValues, setPendingValues] = useState<FormData | null>(null);

  /** Submit path for "Submit for approval". Drafts bypass this entirely — they're private
   *  working state, and the server only gates SUBMITTED. */
  const requestSubmit = (values: FormData) => {
    if (faceStatus.data?.requiredForTimesheet) {
      setPendingValues(values);
      setFaceDialogOpen(true);
      return;
    }
    mutation.mutate({ values, draft: false });
  };

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Timesheet entry</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Capture daily work with hierarchy-aware selects, automatic hour calculation, and rich task notes.
        </p>
      </div>

      <Card data-tour="timesheet-form">
        <CardContent className="pt-6">
          <Form {...form}>
            <form
              ref={formRef}
              className="grid gap-6"
              onSubmit={form.handleSubmit((values) => requestSubmit(values), focusFirstInvalid)}
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
                      <TicketPicker
                        tickets={openTickets.data ?? []}
                        value={field.value || ""}
                        onChange={field.onChange}
                        disabled={!selectedProject}
                        placeholder={selectedProject ? "Search or pick a ticket…" : "Pick a project first"}
                      />
                      <FormDescription>Attribute this entry's hours to a bug or task for effort reporting. Type to search when the list is long.</FormDescription>
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
                        {/* Calendar instead of a native date input: identical in every browser,
                            and future dates are simply not selectable rather than rejected after
                            the fact. */}
                        <DatePicker
                          value={field.value ?? ""}
                          onChange={field.onChange}
                          maxValue={new Date().toISOString().slice(0, 10)}
                          placeholder="Pick the work date"
                        />
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
                      <FormControl>
                        <TimeField value={field.value ?? ""} onChange={field.onChange} aria-label="Start time" />
                      </FormControl>
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
                      <FormControl>
                        <TimeField value={field.value ?? ""} onChange={field.onChange} aria-label="End time" />
                      </FormControl>
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
                      <RefinableRichText
                        refineField="timesheet_description"
                        refineLabel="task description"
                        label="Task description"
                        value={field.value}
                        onChange={field.onChange}
                        placeholder="What did you build, fix, document, or review? Use formatting to keep it scannable."
                        minHeight="min-h-36"
                        ariaLabel="Task description"
                        meta={
                          <span className={`text-xs font-normal ${length < 10 ? "text-destructive" : "text-muted-foreground"}`}>
                            {length} / min 10
                          </span>
                        }
                      />
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
                    <RefinableRichText
                      refineField="timesheet_notes"
                      refineLabel="notes"
                      label={<>Additional notes <span className="text-muted-foreground">(optional)</span></>}
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      placeholder="Blockers, dependencies, follow-ups..."
                      minHeight="min-h-24"
                      ariaLabel="Additional notes"
                    />
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
                    onClick={form.handleSubmit((values) => mutation.mutate({ values, draft: true }), focusFirstInvalid)}
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

      <FaceVerificationDialog
        open={faceDialogOpen}
        onOpenChange={(open) => {
          setFaceDialogOpen(open);
          if (!open) setPendingValues(null);
        }}
        context="TIMESHEET"
        actionLabel="submit this timesheet"
        onVerified={(verificationId) => {
          if (pendingValues) mutation.mutate({ values: pendingValues, draft: false, faceVerificationId: verificationId });
          setPendingValues(null);
        }}
      />
    </div>
  );
}
