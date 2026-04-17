import type { ComponentProps } from "react";

type ButtonVariant = "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
type ButtonSize = "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";

interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonProps) {
  const classes = [
    "ui-btn",
    variant !== "default" ? `ui-btn-${variant}` : "",
    size !== "default" ? `ui-btn-sz-${size}` : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return <button data-slot="button" className={classes} {...props} />;
}

export { Button };
export type { ButtonProps, ButtonVariant, ButtonSize };
