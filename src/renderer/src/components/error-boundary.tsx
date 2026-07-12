import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  message: string | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    message: null
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      message: error.message
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[renderer] uncaught error", error, info);
  }

  render() {
    if (this.state.message) {
      return (
        <div className="min-h-screen bg-background p-6 text-sm text-rose-700">
          <div className="rounded-md border border-rose-200 bg-rose-50 p-4">
            <div className="font-medium">界面渲染失败</div>
            <div className="mt-2 break-all">{this.state.message}</div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
