/**
 * WHAT: the app's only React error boundary.
 *
 * WHY it exists: before this, there was none anywhere — so a single render-time throw in any page
 * unmounted the entire tree and left the user staring at a blank white screen with no explanation
 * and no way forward except discovering F5 themselves. React has no default UI for this.
 *
 * WHY a class component: `componentDidCatch`/`getDerivedStateFromError` have no hook equivalent.
 * This is the one place in the codebase where a class is the correct tool.
 *
 * Deliberately NOT wired to a reporting service — this repo has no error-tracking integration on
 * the frontend, and inventing one here would be scope creep. It logs to the console (so the trace
 * is still in devtools and in Playwright's captured output) and gives the user a recovery path.
 */
import { AlertTriangle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] render failed:", error, info.componentStack);
  }

  private readonly reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid min-h-screen place-items-center bg-background p-4">
        <div className="w-full max-w-lg rounded-lg border border-destructive/40 bg-card p-6 shadow-lg">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-destructive/10 text-destructive">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold tracking-tight">Something broke on this screen</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                This is a bug in the app, not something you did. Your data hasn't been touched — the failure happened while
                drawing the page.
              </p>
              {/* The message only; never the stack. A stack trace in the UI is noise to a user and
                  can leak internal paths/identifiers. The full trace goes to the console. */}
              <p className="mt-3 break-words rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
                {error.message || "Unknown error"}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" onClick={this.reset}>
                  Try again
                </Button>
                <Button size="sm" variant="outline" onClick={() => window.location.assign("/app")}>
                  Back to dashboard
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
