import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null
  };

  constructor(props: Props) {
    super(props);
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error in UI component:', error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 rounded-2xl bg-danger-soft border border-danger/40 text-foreground max-w-xl mx-auto my-8 shadow-overlay">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-danger shrink-0 mt-0.5" />
            <div className="space-y-3 flex-1">
              <h3 className="font-bold text-foreground text-base">
                {this.props.fallbackTitle || 'Unable to display this view'}
              </h3>
              <p className="text-xs text-danger-soft-foreground/85 leading-relaxed">
                An unexpected display error occurred while rendering this component.
              </p>
              {this.state.error && (
                <div className="p-2.5 rounded-lg bg-surface-secondary font-mono text-[11px] text-danger-soft-foreground border border-danger/30 break-all">
                  {this.state.error.message}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={this.handleReset}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-danger hover:bg-danger-hover text-danger-foreground text-xs font-semibold transition"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Dismiss & Recover
                </button>
                <button
                  type="button"
                  onClick={() => {
                    try {
                      localStorage.clear();
                      sessionStorage.clear();
                    } catch {}
                    window.location.reload();
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-secondary hover:bg-surface-tertiary text-foreground border border-border text-xs font-medium transition"
                >
                  Clear Cached Storage & Reset
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
