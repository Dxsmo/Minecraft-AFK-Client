import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Changing this remounts the boundary, e.g. on navigation. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches render errors of the page currently shown. Without this, a single bad
 * field in an API response takes the entire app down to a blank black screen
 * with no indication of what went wrong.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // A new page gets a clean slate, so navigating away recovers.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div
        className="rounded-xl border p-6"
        style={{ borderColor: "var(--border)", backgroundColor: "var(--surface)" }}
      >
        <h2 className="text-base font-semibold" style={{ color: "#f87171" }}>
          Diese Seite ist abgestürzt
        </h2>
        <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
          Die restliche Anwendung läuft weiter — wechsle die Seite oder lade neu.
        </p>
        <pre
          className="mt-3 overflow-x-auto rounded-lg p-3 text-[11px]"
          style={{
            backgroundColor: "var(--bg-elev)",
            border: "1px solid var(--border)",
            color: "var(--text-subtle)",
          }}
        >
          {this.state.error.message}
        </pre>
        <button
          type="button"
          className="btn btn-primary btn-sm mt-3"
          onClick={() => this.setState({ error: null })}
        >
          Erneut versuchen
        </button>
      </div>
    );
  }
}
