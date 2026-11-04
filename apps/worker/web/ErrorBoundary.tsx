import { Component, type ReactNode } from "react";

/** Last line of defence: a render error shows a recoverable message instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error("UI error", error);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="shell">
        <div className="panel error stack" role="alert">
          <h2>Something went wrong on this screen.</h2>
          <p className="small">{this.state.error.message}</p>
          <div>
            <button className="primary" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
