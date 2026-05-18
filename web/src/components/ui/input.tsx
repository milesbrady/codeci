import { cn } from "@/lib/utils";
import { type InputHTMLAttributes, forwardRef } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-10 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500",
        "focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "transition-colors",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";
