import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

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
        <div className="min-h-screen bg-background p-4 sm:p-6">
          <Alert className="mx-auto max-w-2xl" variant="destructive">
            <AlertTitle>界面渲染失败</AlertTitle>
            <AlertDescription className="break-all">{this.state.message}</AlertDescription>
          </Alert>
        </div>
      );
    }

    return this.props.children;
  }
}
