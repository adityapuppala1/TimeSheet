/**
 * WHAT: a type-ahead replacement for `<Select>` wherever the option list can get long — currently
 * the module and submodule pickers on the timesheet form and its edit dialog.
 *
 * WHY IT EXISTS: a plain dropdown is fine at ten options and unusable at eighty, and a real
 * project's module list gets there. `pages/Timesheet.tsx` already proved the pattern with its
 * `TicketPicker`; this is that same Popover + cmdk shape generalised, so the two pickers sitting
 * next to each other on the same row behave identically instead of one searching and one not.
 *
 * WHY IT IS NOT A DROP-IN `<Select>`: it deliberately keeps the same three props the Selects it
 * replaced were given — `value`, `onChange`, `disabled` — so the cascade logic in both call sites
 * (clearing the submodule when the module changes) is untouched. The empty string is the "nothing
 * selected" value in both, matching what the forms already store.
 *
 * ACCESSIBILITY: `role="combobox"` + `aria-expanded` on the trigger, and cmdk owns arrow-key
 * navigation and type-ahead, so keyboard use matches the ticket picker people already know.
 */
import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./command";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export interface SearchableOption {
  id: string;
  name: string;
}

export function SearchableSelect({
  options,
  value,
  onChange,
  disabled,
  placeholder,
  searchPlaceholder = "Type to search…",
  emptyText = "No matches.",
  /** Renders a "—" row that clears the selection. Only for genuinely optional fields. */
  clearable = false,
  clearLabel = "None",
  className,
  "aria-label": ariaLabel
}: {
  options: SearchableOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  placeholder: string;
  searchPlaceholder?: string;
  emptyText?: string;
  clearable?: boolean;
  clearLabel?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          /* `min-w-0` is load-bearing, not tidying. `truncate` sets overflow:hidden +
             text-overflow:ellipsis, but a flex/grid item defaults to `min-width: auto`, which
             refuses to shrink below its own content — so a long value grows the trigger past its
             column instead of ellipsing, and the whole page scrolls sideways. Measured: a 250px
             cell rendering a 727px trigger. Needed on the button (a grid item) AND on the span
             (a flex item inside it). */
          className={cn("w-full min-w-0 justify-between font-normal", className)}
        >
          <span className={cn("min-w-0 truncate", selected ? "" : "text-muted-foreground")}>
            {selected ? selected.name : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {clearable && (
                <CommandItem
                  // Prefixed so a module genuinely named "None" cannot collide with this row in
                  // cmdk's value-matching.
                  value={`__clear__ ${clearLabel}`}
                  onSelect={() => {
                    onChange("");
                    setOpen(false);
                  }}
                >
                  <Check className={cn("mr-2 h-4 w-4", value === "" ? "opacity-100" : "opacity-0")} />
                  <span className="text-muted-foreground">{clearLabel}</span>
                </CommandItem>
              )}
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  // cmdk filters on this string, not on the id — searching has to match what the
                  // person can actually read in the list.
                  value={option.name}
                  onSelect={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("mr-2 h-4 w-4", value === option.id ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{option.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
