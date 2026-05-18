import { cn } from "@/lib/utils";
import { type HTMLAttributes } from "react";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "success" | "error" | "warning" | "running";
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  const variants = {
    default: "bg-zinc-800 text-zinc-300",
    success: "bg-emerald-950 text-emerald-400 border border-emerald-800",
    error: "bg-red-950 text-red-400 border border-red-800",
    warning: "bg-amber-950 text-amber-400 border border-amber-800",
    running: "bg-blue-950 text-blue-400 border border-blue-800",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        variants[variant],
        className
      )}
      {...props}
    />
  );
}
