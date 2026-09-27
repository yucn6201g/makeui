import { Component, type ReactNode, type ErrorInfo } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary" role="alert">
          <div className="error-boundary__card">
            <h1 className="error-boundary__title">エラーが発生しました</h1>
            <p className="error-boundary__message">
              画面を表示できませんでした。「再試行」を押すか、ページを再読み込みしてください。
            </p>
            {/* The exception itself, for whoever is asked to look into it — not the sentence a person reads. */}
            {this.state.error?.message && (
              <details className="error-boundary__detail">
                <summary>詳細</summary>
                <code>{this.state.error.message}</code>
              </details>
            )}
            <button
              className="error-boundary__btn"
              onClick={this.handleReset}
              type="button"
            >
              再試行
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
