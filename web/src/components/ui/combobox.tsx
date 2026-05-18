import { useState, useRef, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Check, ChevronsUpDown, Search, Loader2 } from "lucide-react";

interface ComboboxProps {
  options: { label: string; value: string }[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Select option...",
  disabled,
  loading,
  className,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  const filteredOptions = useMemo(() => {
    if (!search) return options;
    const lowerSearch = search.toLowerCase();
    return options.filter((opt) =>
      opt.label.toLowerCase().includes(lowerSearch)
    );
  }, [options, search]);

  // Lazy loading: only render the first 100 options for performance
  const displayedOptions = useMemo(() => filteredOptions.slice(0, 100), [filteredOptions]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className={cn("relative w-full", className)} ref={containerRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        title={selectedOption ? selectedOption.label : undefined}
        className={cn(
          "flex min-h-10 w-full items-start justify-between gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100",
          "focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent",
          "disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-left",
          !value && "text-zinc-500"
        )}
      >
        <span className="flex-1 min-w-0 break-all whitespace-normal leading-5">
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        {loading ? (
          <Loader2 className="h-4 w-4 mt-0.5 animate-spin shrink-0 opacity-50" />
        ) : (
          <ChevronsUpDown className="h-4 w-4 mt-0.5 shrink-0 opacity-50" />
        )}
      </button>

      {open && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 shadow-xl animate-in fade-in zoom-in-95 duration-100">
          <div className="flex items-center border-b border-zinc-800 px-3">
            <Search className="mr-2 h-4 w-4 shrink-0 opacity-50 text-zinc-400" />
            <input
              className="flex h-10 w-full bg-transparent py-3 text-sm outline-none placeholder:text-zinc-500 disabled:cursor-not-allowed disabled:opacity-50 text-zinc-100"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          <div className="max-h-48 overflow-y-auto p-1 custom-scrollbar">
            {displayedOptions.length === 0 ? (
              <div className="py-6 text-center text-sm text-zinc-500">
                No options found.
              </div>
            ) : (
              displayedOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  title={option.label}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={cn(
                    "relative flex w-full cursor-default select-none items-start gap-2 rounded-sm px-2 py-1.5 text-sm outline-none text-left",
                    "hover:bg-violet-600 hover:text-white transition-colors",
                    value === option.value ? "bg-zinc-800 text-zinc-100" : "text-zinc-400"
                  )}
                >
                  <Check
                    className={cn(
                      "h-4 w-4 mt-0.5 flex-shrink-0",
                      value === option.value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="flex-1 min-w-0 break-all whitespace-normal leading-5">
                    {option.label}
                  </span>
                </button>
              ))
            )}
            {filteredOptions.length > 100 && (
              <div className="px-2 py-1.5 text-[10px] text-zinc-500 italic border-t border-zinc-800 mt-1">
                Showing first 100 of {filteredOptions.length} matches. Type to refine.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
