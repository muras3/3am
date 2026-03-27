import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Translation } from "react-i18next";
import { Button } from "../ui/button.js";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Translation>
          {(t) => (
            <div className="error-boundary-fallback">
              <p className="error-boundary-message">{t("common.error.somethingWentWrong")}</p>
              <Button
                variant="outline"
                onClick={() => window.location.reload()}
              >
                {t("common.error.reload")}
              </Button>
            </div>
          )}
        </Translation>
      );
    }
    return this.props.children;
  }
}
