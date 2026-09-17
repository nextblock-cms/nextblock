"use client";

import React from 'react';
import { Check, ChevronsUpDown, Loader2, Search, X } from 'lucide-react';
import {
  Badge,
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@nextblock-cms/ui';
import { cn } from '@nextblock-cms/utils';

/**
 * A checkbox *look* without the interactive element. The whole option row is the
 * button, and Radix's `Checkbox` renders its own `<button>` — nesting the two is
 * invalid HTML and breaks hydration.
 */
function CheckIndicator({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border border-primary transition-colors',
        checked && 'bg-primary text-primary-foreground'
      )}
    >
      {checked && <Check className="h-3 w-3" />}
    </span>
  );
}

export interface PickerOption {
  id: string;
  label: string;
  /** Secondary line under the label, e.g. a slug or SKU. */
  description?: string | null;
  /** Small trailing tag, e.g. a language code or publish status. */
  badge?: string | null;
}

interface MultiEntityPickerProps {
  options: PickerOption[];
  /**
   * Labels for already-selected ids that the current `options` page may not
   * contain (server-filtered lists). Used for the chips only, never listed.
   */
  selectedOptions?: PickerOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  /** Singular / plural noun used in the trigger label, e.g. ['category', 'categories']. */
  nouns: [string, string];
  isLoading?: boolean;
  /**
   * Provide to filter server-side (the component then stops filtering locally).
   * Omit for a fully client-side list.
   */
  onSearchChange?: (query: string) => void;
  /** Number the selected chips — use when selection order is display order. */
  showOrder?: boolean;
  maxSelected?: number;
  /** Extra line under the control, e.g. "Showing the first 50 products". */
  hint?: React.ReactNode;
}

export default function MultiEntityPicker({
  options,
  selectedOptions: selectedOptionsProp,
  selectedIds,
  onChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyMessage = 'Nothing found.',
  nouns,
  isLoading = false,
  onSearchChange,
  showOrder = false,
  maxSelected,
  hint,
}: MultiEntityPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const isServerFiltered = typeof onSearchChange === 'function';

  const labelsById = React.useMemo(
    () =>
      new Map(
        [...options, ...(selectedOptionsProp ?? [])].map((option) => [option.id, option])
      ),
    [options, selectedOptionsProp]
  );

  // Selection order is meaningful (it drives display order), so walk selectedIds
  // rather than options. Ids whose option has not loaded yet still get a chip.
  const selectedOptions = React.useMemo(
    () =>
      selectedIds.map(
        (id) => labelsById.get(id) ?? { id, label: 'Loading…', description: null }
      ),
    [selectedIds, labelsById]
  );

  const filteredOptions = React.useMemo(() => {
    if (isServerFiltered || !searchQuery.trim()) return options;
    const query = searchQuery.trim().toLowerCase();
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(query) ||
        (option.description ?? '').toLowerCase().includes(query)
    );
  }, [options, searchQuery, isServerFiltered]);

  const atLimit = typeof maxSelected === 'number' && selectedIds.length >= maxSelected;

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    onSearchChange?.(value);
  };

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((selectedId) => selectedId !== id));
      return;
    }
    if (atLimit) return;
    onChange([...selectedIds, id]);
  };

  const remove = (id: string) => onChange(selectedIds.filter((selectedId) => selectedId !== id));

  const [singular, plural] = nouns;
  const triggerLabel =
    selectedIds.length > 0
      ? `${selectedIds.length} ${selectedIds.length === 1 ? singular : plural} selected`
      : placeholder;

  return (
    <div className="space-y-2">
      {selectedOptions.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 rounded-md border bg-muted/30 p-1.5">
          {selectedOptions.map((option, index) => (
            <li key={option.id}>
              <Badge
                variant="secondary"
                className="flex items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-xs font-normal"
              >
                {showOrder && (
                  <span className="text-[10px] font-semibold tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                )}
                <span className="max-w-[180px] truncate">{option.label}</span>
                <button
                  type="button"
                  onClick={() => remove(option.id)}
                  aria-label={`Remove ${option.label}`}
                  className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-9 w-full justify-between text-xs font-normal"
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
          <div className="flex items-center border-b px-3">
            {isLoading ? (
              <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin opacity-50" />
            ) : (
              <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
            )}
            <Input
              autoFocus
              className="h-9 w-full border-0 bg-transparent py-2 text-xs shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              placeholder={searchPlaceholder}
              value={searchQuery}
              onChange={(event) => handleSearchChange(event.target.value)}
            />
          </div>

          <div
            role="listbox"
            aria-multiselectable="true"
            className="max-h-60 overflow-y-auto p-1"
          >
            {filteredOptions.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                {isLoading ? 'Loading…' : emptyMessage}
              </p>
            ) : (
              filteredOptions.map((option) => {
                const isChecked = selectedIds.includes(option.id);
                const isBlocked = !isChecked && atLimit;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={isChecked}
                    disabled={isBlocked}
                    onClick={() => toggle(option.id)}
                    className={cn(
                      'relative flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none transition-colors',
                      isBlocked
                        ? 'cursor-not-allowed opacity-40'
                        : 'cursor-pointer hover:bg-accent hover:text-accent-foreground',
                      isChecked && 'bg-accent/40'
                    )}
                  >
                    <CheckIndicator checked={isChecked} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{option.label}</span>
                      {option.description && (
                        <span className="truncate font-mono text-[10px] leading-tight text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </span>
                    {option.badge && (
                      <Badge
                        variant="outline"
                        className="ml-auto shrink-0 px-1.5 py-0 text-[9px] uppercase"
                      >
                        {option.badge}
                      </Badge>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {atLimit && (
            <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
              Limit reached ({maxSelected}). Remove one to add another.
            </p>
          )}
        </PopoverContent>
      </Popover>

      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}
