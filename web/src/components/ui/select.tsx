import { cn } from "@/lib/utils";
import { type SelectHTMLAttributes, forwardRef } from "react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: { label: string; value: string }[];
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, options, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "flex h-10 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100",
        "focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "transition-colors appearance-none",
        className
      )}
      {...props}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-zinc-900">
          {o.label}
        </option>
      ))}
    </select>
  )
);
Select.displayName = "Select";
