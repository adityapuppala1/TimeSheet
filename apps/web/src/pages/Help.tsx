/**
 * WHAT: the in-app help — every SOP, flow and FAQ, searchable, filtered to what the viewer's role
 * can actually do.
 *
 * THE CONTENT IS NOT HERE. Articles live in `@timesheet/shared` (help-articles.ts) because Ask AI
 * answers "how do I…" questions from the same array through the same role filter — this page and
 * the assistant are two views of one document, which is the only arrangement under which they
 * cannot contradict each other.
 *
 * ROLE FILTERING IS COURTESY, NOT SECURITY. An employee's help page hides the super-admin SOPs
 * because reading "go to Workspace settings → Billing" is useless to somebody whose sidebar has no
 * such entry — not because the text is secret. The pages those articles describe enforce their own
 * access; this filter only keeps the manual honest about what its reader can do.
 *
 * SEARCH IS THE SHARED FUNCTION, deliberately: typing "approve" here and asking the assistant "how
 * do I approve a timesheet" walk the same scoring, so the page and the chat agree about which
 * article answers it.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { BookOpen, ChevronRight, Lock, Search, Sparkles } from "lucide-react";
import {
  HELP_CATEGORIES,
  searchHelpArticles,
  type HelpArticle,
  type HelpCategory,
  type RoleName
} from "@timesheet/shared";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { useAuthStore } from "../store/auth";

function ArticleCard({ article }: { readonly article: HelpArticle }) {
  return (
    <article
      id={article.id}
      // scroll-mt clears the sticky search header when a deep link or search hit jumps here.
      className="scroll-mt-36 rounded-xl border border-border bg-card p-5 transition-shadow hover:shadow-soft"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wider text-primary">{article.category}</p>
        {article.roles && (
          <Badge variant="muted" className="gap-1 text-[10px]">
            <Lock className="h-2.5 w-2.5" aria-hidden />
            {article.roles.map((r) => r.replace("_", " ")).join(" / ")}
          </Badge>
        )}
      </div>
      <h3 className="mt-1.5 text-lg font-bold tracking-tight">{article.title}</h3>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{article.when}</p>

      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Where</p>
      <p className="text-sm">{article.where}</p>

      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Steps</p>
      <ol className="mt-1 grid gap-1.5">
        {article.steps.map((step, i) => (
          <li key={step} className="flex gap-2.5 text-sm leading-6">
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
              {i + 1}
            </span>
            <span className="min-w-0">{step}</span>
          </li>
        ))}
      </ol>

      {article.notes && (
        <p className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">{article.notes}</p>
      )}

      {article.screenshot && (
        <figure className="mt-4">
          {/* The twelve real captures the marketing pages use — nothing mocked up for the manual. */}
          <img
            src={`/product/${article.screenshot}`}
            alt={`Screenshot: ${article.title}`}
            loading="lazy"
            className="w-full rounded-lg border border-border"
          />
        </figure>
      )}
    </article>
  );
}

export function HelpPage() {
  const user = useAuthStore((s) => s.user);
  const role = (user?.role ?? "EMPLOYEE") as RoleName;
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<HelpCategory | "all">("all");

  const results = useMemo(() => {
    const matched = searchHelpArticles(query, role);
    return category === "all" ? matched : matched.filter((a) => a.category === category);
  }, [query, category, role]);

  // Only the categories this role has articles in — a chip that always filters to nothing is a
  // button-shaped apology.
  const categories = useMemo(() => {
    const present = new Set(searchHelpArticles("", role).map((a) => a.category));
    return HELP_CATEGORIES.filter((c) => present.has(c));
  }, [role]);

  // Deep links (/app/help#raise-ticket) land on their article once the list has rendered.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    const el = document.getElementById(id);
    el?.scrollIntoView({ block: "start" });
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<HelpCategory, HelpArticle[]>();
    for (const a of results) map.set(a.category, [...(map.get(a.category) ?? []), a]);
    return [...map.entries()];
  }, [results]);

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-5">
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <BookOpen className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tight">Help & how-to</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every flow, from signing in to shipping a change — shown for what your role can actually do.
          </p>
        </div>
      </div>

      {/* Sticky, because on a page this long the search box IS the navigation. */}
      <div className="sticky top-16 z-10 -mx-2 grid gap-2.5 rounded-xl border border-border bg-background/95 p-3 backdrop-blur">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the manual — “raise a ticket”, “approve”, “SSO”, “install”…"
            className="pl-9"
            aria-label="Search help articles"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(["all", ...categories] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c as HelpCategory | "all")}
              aria-pressed={category === c}
              className={`focus-ring rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                category === c
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
              }`}
            >
              {c === "all" ? `All (${searchHelpArticles(query, role).length})` : c}
            </button>
          ))}
        </div>
      </div>

      {results.length === 0 && (
        <div className="grid gap-2 rounded-xl border border-border bg-muted/30 p-6 text-center">
          <p className="font-semibold">Nothing matched “{query}”</p>
          <p className="text-sm text-muted-foreground">
            Try a different word — or ask the assistant, which searches the same articles and can also read your actual data.
          </p>
          <Link to="/app/ask-ai" className="focus-ring mx-auto inline-flex items-center gap-1.5 rounded font-semibold text-primary hover:underline">
            <Sparkles className="h-4 w-4" aria-hidden /> Ask AI instead <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      )}

      {grouped.map(([cat, articles]) => (
        <section key={cat} className="grid gap-3">
          <h2 className="mt-2 text-sm font-black uppercase tracking-wider text-muted-foreground">{cat}</h2>
          {articles.map((a) => (
            <ArticleCard key={a.id} article={a} />
          ))}
        </section>
      ))}

      <p className="pb-8 text-center text-xs text-muted-foreground">
        These same articles power Ask AI's how-to answers — asking “how do I raise a change?” in the chat reads exactly this manual, filtered to your role.
      </p>
    </div>
  );
}
