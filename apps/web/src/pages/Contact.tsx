/**
 * WHAT: `/contact` — the public page behind "Talk to sales", and the only place on this deployment
 * where somebody with no account can start a conversation with a person.
 *
 * WHY IT IS TWO COLUMNS AND NOT JUST A FORM. An enterprise buyer filling in a contact form is
 * weighing a risk, not completing a task: what happens to this address, how long until somebody
 * answers, and whether the three things their security review will ask about have answers. A form
 * on its own asks them to take all of that on faith at exactly the moment they are least inclined
 * to. So the reassurance sits BESIDE the fields, visible while they type, rather than on a page
 * they would have to go and find.
 *
 * THE THREE ANSWERS ARE THE LANDING PAGE'S OWN, imported from components/marketing/faq.ts rather
 * than rewritten. A second, shorter version of "can we turn AI off entirely" is a second promise,
 * and the one that gets edited later is never both of them.
 *
 * WHAT THE FORM ASKS FOR, and why it is not shorter. Every optional field here is optional; the
 * required ones are the four that decide whether a human can answer usefully (who, where they work,
 * how big, and what they actually want). The three selects exist because "how would you run it" and
 * "when" route the enquiry to a different answer, and asking them here costs one click instead of
 * one round trip of email.
 *
 * ANTI-SPAM, and it is deliberately invisible: a honeypot field no person can reach, and the time
 * the form spent on screen (measured on a MONOTONIC clock, so a visitor whose system clock is wrong
 * is not punished for it). There is no captcha, on purpose — the FAQ two columns to the right
 * promises that nothing calls home, and embedding a third-party challenge would make that sentence
 * false on the page that says it.
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, CheckCircle2, Clock, Loader2, Send, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Link } from "react-router";
import { z } from "zod";
import {
  DEPLOYMENT_INTERESTS,
  DEPLOYMENT_LABEL,
  INTEREST_LABEL,
  SALES_INTERESTS,
  SALES_TIMELINES,
  TEAM_SIZE_BANDS,
  TEAM_SIZE_LABEL,
  TIMELINE_LABEL
} from "@timesheet/shared";
import { faqEntries } from "../components/marketing/faq";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { salesLeadApi } from "../services/platform-admin-api";

/**
 * "One of these, and you have to pick" — as a string rather than `z.enum`, so the field can start
 * empty. `z.enum` would make `""` an impossible default and force the initial state to be a lie
 * (some band pre-selected that nobody chose), which is how a form ends up reporting that every
 * company has 51–200 people.
 */
const oneOf = (values: readonly string[], message: string) => z.string().refine((value) => values.includes(value), { message });

const contactSchema = z.object({
  name: z.string().trim().min(2, "Tell us your name").max(120),
  email: z.string().trim().email("Enter a valid email address").max(255),
  company: z.string().trim().min(2, "Tell us where you work").max(200),
  role: z.string().trim().max(120),
  country: z.string().trim().max(120),
  phone: z.string().trim().max(40),
  teamSize: oneOf(TEAM_SIZE_BANDS, "Roughly how many people?"),
  deploymentInterest: oneOf(DEPLOYMENT_INTERESTS, "Pick one — “not decided yet” is a real answer"),
  timeline: oneOf(SALES_TIMELINES, "When are you looking at this?"),
  interests: z.array(z.string()),
  message: z.string().trim().min(10, "A sentence or two about what you need").max(4000)
});

type ContactValues = z.infer<typeof contactSchema>;

/** The three answers a security review asks for, by id — see components/marketing/faq.ts. */
const REASSURANCE = faqEntries("data-residency", "ai-off", "self-host");

/** Add or remove one code from the multi-select. Lifted out of the checkbox handler so the render
 *  prop does not end up four closures deep for a one-line list edit. */
const toggleInterest = (current: string[], option: string, on: boolean) => (on ? [...current, option] : current.filter((value) => value !== option));

/** Whatever the campaign put in the URL, if anything. Absent is normal and never a problem. */
function capturedContext() {
  const params = new URLSearchParams(window.location.search);
  return {
    sourcePage: `${window.location.pathname}${window.location.search}`.slice(0, 255),
    referrer: document.referrer.slice(0, 500) || undefined,
    utmSource: params.get("utm_source")?.slice(0, 120) || undefined,
    utmMedium: params.get("utm_medium")?.slice(0, 120) || undefined,
    utmCampaign: params.get("utm_campaign")?.slice(0, 120) || undefined
  };
}

export function Contact() {
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  const [sent, setSent] = useState<{ responseWindow: string } | null>(null);

  /**
   * When the form appeared, on the monotonic clock. `performance.now()` and not `Date.now()`: the
   * server only sees the INTERVAL, so a laptop whose clock is five minutes fast cannot be refused
   * for having filled the form in negative time. A `useRef` rather than state because reading it
   * must never cause a render.
   */
  const renderedAt = useRef(0);
  useEffect(() => {
    renderedAt.current = performance.now();
  }, []);

  const form = useForm<ContactValues>({
    resolver: zodResolver(contactSchema),
    defaultValues: {
      name: "",
      email: "",
      company: "",
      role: "",
      country: "",
      phone: "",
      teamSize: "",
      deploymentInterest: "",
      timeline: "",
      interests: [],
      message: ""
    }
  });
  const { errors } = form.formState;

  const submit = async (values: ContactValues) => {
    setBusy(true);
    setServerError("");
    try {
      const result = await salesLeadApi.submit({
        ...values,
        role: values.role || undefined,
        country: values.country || undefined,
        phone: values.phone || undefined,
        ...capturedContext(),
        // The honeypot, always empty from a person. The field below is hidden from sight AND from
        // assistive technology, so nobody using this page can reach it.
        website: "",
        elapsedMs: Math.max(0, Math.round(performance.now() - renderedAt.current))
      });
      setSent({ responseWindow: result.responseWindow });
    } catch (err: any) {
      // 429 gets its own sentence because the limiter answers with express-rate-limit's default
      // body, and a bare "couldn't send" for something that will work again shortly reads as
      // broken rather than as throttled.
      setServerError(
        err?.response?.status === 429
          ? "That is a few too many messages from this network. Wait a little and try again — or just email us directly, which always works."
          : (err?.response?.data?.message ?? "We couldn't send that. Try again, or email us directly.")
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-muted/30 px-4 py-10">
      <div className="mx-auto w-full max-w-5xl">
        <Link to="/" className="focus-ring mb-4 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>

        {/* The form column is wide enough for two fields side by side; the reassurance column is
            capped so its paragraphs stay readable. Below `lg` they stack, form first — somebody who
            arrived from "Talk to sales" came to write, not to read. */}
        <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Card className="min-w-0">
            <CardHeader>
              <div className="mb-1 grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
                {sent ? <CheckCircle2 className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
              </div>
              <CardTitle>{sent ? "Message received" : "Talk to us"}</CardTitle>
              <CardDescription>
                {sent
                  ? `A person will reply within ${sent.responseWindow}. We have emailed you a copy of what you sent.`
                  : "Tell us what you are trying to do and who it is for. A person reads every one of these."}
              </CardDescription>
            </CardHeader>

            <CardContent>
              {/* THE FORM IS REPLACED, not left on screen behind a banner: a filled form under a
                  success message invites a second submission of the same enquiry, and the person
                  who sends it has no way of knowing whether the first one counted. */}
              {sent ? (
                <div className="grid gap-4">
                  <p className="text-sm text-muted-foreground">
                    Nothing else is needed from you. If it is urgent, reply to the confirmation email — it reaches the same person, and it is not a no-reply address.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild>
                      <Link to="/signup">Start a free trial while you wait</Link>
                    </Button>
                    <Button asChild variant="outline">
                      <Link to="/">Back to the site</Link>
                    </Button>
                  </div>
                </div>
              ) : (
                <form onSubmit={form.handleSubmit(submit)} className="grid gap-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="contact-name">Your name</Label>
                      <Input id="contact-name" autoComplete="name" placeholder="Priya Raman" {...form.register("name")} />
                      {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="contact-email">Work email</Label>
                      <Input id="contact-email" type="email" autoComplete="email" placeholder="you@company.com" {...form.register("email")} />
                      {/* No free-mail warning here, deliberately. A personal address is a perfectly
                          good way to ask a question — it is only signing up for a workspace that
                          needs a company behind it. */}
                      {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="contact-company">Company</Label>
                      <Input id="contact-company" autoComplete="organization" placeholder="Northwind Logistics" {...form.register("company")} />
                      {errors.company && <p className="text-xs text-destructive">{errors.company.message}</p>}
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="contact-role">Your role <span className="text-muted-foreground">(optional)</span></Label>
                      <Input id="contact-role" autoComplete="organization-title" placeholder="Head of Operations" {...form.register("role")} />
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-3">
                    <Controller
                      control={form.control}
                      name="teamSize"
                      render={({ field }) => (
                        <div className="grid gap-1.5">
                          <Label htmlFor="contact-team">Team size</Label>
                          <Select value={field.value} onValueChange={field.onChange}>
                            <SelectTrigger id="contact-team">
                              <SelectValue placeholder="Choose" />
                            </SelectTrigger>
                            <SelectContent>
                              {TEAM_SIZE_BANDS.map((band) => (
                                <SelectItem key={band} value={band}>
                                  {TEAM_SIZE_LABEL[band]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {errors.teamSize && <p className="text-xs text-destructive">{errors.teamSize.message}</p>}
                        </div>
                      )}
                    />
                    <Controller
                      control={form.control}
                      name="deploymentInterest"
                      render={({ field }) => (
                        <div className="grid gap-1.5">
                          <Label htmlFor="contact-deployment">How would you run it?</Label>
                          <Select value={field.value} onValueChange={field.onChange}>
                            <SelectTrigger id="contact-deployment">
                              <SelectValue placeholder="Choose" />
                            </SelectTrigger>
                            <SelectContent>
                              {DEPLOYMENT_INTERESTS.map((option) => (
                                <SelectItem key={option} value={option}>
                                  {DEPLOYMENT_LABEL[option]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {errors.deploymentInterest && <p className="text-xs text-destructive">{errors.deploymentInterest.message}</p>}
                        </div>
                      )}
                    />
                    <Controller
                      control={form.control}
                      name="timeline"
                      render={({ field }) => (
                        <div className="grid gap-1.5">
                          <Label htmlFor="contact-timeline">Timeline</Label>
                          <Select value={field.value} onValueChange={field.onChange}>
                            <SelectTrigger id="contact-timeline">
                              <SelectValue placeholder="Choose" />
                            </SelectTrigger>
                            <SelectContent>
                              {SALES_TIMELINES.map((option) => (
                                <SelectItem key={option} value={option}>
                                  {TIMELINE_LABEL[option]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {errors.timeline && <p className="text-xs text-destructive">{errors.timeline.message}</p>}
                        </div>
                      )}
                    />
                  </div>

                  <Controller
                    control={form.control}
                    name="interests"
                    render={({ field }) => (
                      <fieldset className="grid gap-2">
                        <legend className="mb-1 text-sm font-medium">What are you evaluating? <span className="text-muted-foreground">(optional)</span></legend>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {SALES_INTERESTS.map((option) => {
                            const checked = field.value.includes(option);
                            return (
                              <Label key={option} htmlFor={`contact-interest-${option}`} className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-normal transition hover:border-primary/40">
                                <Checkbox
                                  id={`contact-interest-${option}`}
                                  checked={checked}
                                  onCheckedChange={(next) => field.onChange(toggleInterest(field.value, option, next === true))}
                                />
                                {INTEREST_LABEL[option]}
                              </Label>
                            );
                          })}
                        </div>
                      </fieldset>
                    )}
                  />

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="contact-country">Country <span className="text-muted-foreground">(optional)</span></Label>
                      <Input id="contact-country" autoComplete="country-name" placeholder="United Kingdom" {...form.register("country")} />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="contact-phone">Phone <span className="text-muted-foreground">(optional)</span></Label>
                      <Input id="contact-phone" type="tel" autoComplete="tel" placeholder="+44 20 7946 0123" {...form.register("phone")} />
                    </div>
                  </div>

                  <div className="grid gap-1.5">
                    <Label htmlFor="contact-message">What do you need?</Label>
                    <Textarea id="contact-message" rows={5} maxLength={4000} placeholder="How many people, what you use today, and what is not working about it." {...form.register("message")} />
                    {errors.message && <p className="text-xs text-destructive">{errors.message.message}</p>}
                  </div>

                  {/* THE HONEYPOT. `aria-hidden` and `tabIndex={-1}` as well as hidden, so no
                      keyboard or screen-reader user can land in it by accident — a honeypot that
                      catches people is worse than no honeypot. It is registered but never read
                      here; the submit handler always sends an empty string. */}
                  <div aria-hidden className="hidden">
                    <label htmlFor="contact-website">Website</label>
                    <input id="contact-website" name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
                  </div>

                  {serverError && <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{serverError}</p>}

                  <Button type="submit" disabled={busy} className="w-full sm:w-auto sm:justify-self-start">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    {busy ? "Sending…" : "Send message"}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>

          {/* The column that answers the questions somebody has WHILE they type: how long, what
              happens to the address, and the three facts a security review will ask for. */}
          <aside className="grid min-w-0 gap-4">
            <Card>
              <CardContent className="grid gap-3 pt-6">
                <p className="flex items-start gap-2.5 text-sm">
                  <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span>
                    <strong className="font-semibold text-foreground">A reply within one working day.</strong> From a person who can actually answer the question, not a form acknowledgement pretending to be one.
                  </span>
                </p>
                <p className="flex items-start gap-2.5 text-sm">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span>
                    <strong className="font-semibold text-foreground">No sales sequences.</strong> Your address is used to answer you and nothing else — no drip campaign, no list, no third-party tracker on this page. Say no and you never hear from us again.
                  </span>
                </p>
              </CardContent>
            </Card>

            {/* THE SAME WORDS AS THE LANDING PAGE, imported rather than retyped — see the file
                header. Rendered as <details> for the same reason the FAQ section is: it is correct
                for a keyboard and a screen reader without any JavaScript of ours. */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Answered before you ask</CardTitle>
                <CardDescription>The three that come up in every security review.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2">
                {REASSURANCE.map((item) => (
                  <details key={item.id} className="group rounded-lg border border-border p-3 transition open:shadow-sm hover:border-primary/40">
                    <summary className="focus-ring cursor-pointer list-none rounded text-sm font-semibold marker:content-none">{item.q}</summary>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.a}</p>
                  </details>
                ))}
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>
    </div>
  );
}
