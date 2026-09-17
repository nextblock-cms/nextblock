'use client';

import * as React from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { cn } from '@nextblock-cms/utils';

import { Button } from './button';
import { Input } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

export type SearchableSelectOption = {
  value: string;
  label: string;
  description?: string;
};

export interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Select an option...',
  searchPlaceholder = 'Search...',
  emptyMessage = 'No options found.',
  disabled = false,
  className,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');

  const selectedOption = React.useMemo(
    () => options.find((opt) => opt.value === value),
    [options, value]
  );

  const filteredOptions = React.useMemo(() => {
    if (!searchQuery) return options;
    const lowerQuery = searchQuery.toLowerCase();
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(lowerQuery) ||
        opt.value.toLowerCase().includes(lowerQuery) ||
        opt.description?.toLowerCase().includes(lowerQuery)
    );
  }, [options, searchQuery]);

  // Handle closing when selecting
  const handleSelect = (currentValue: string) => {
    onChange(currentValue);
    setOpen(false);
    setSearchQuery('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn('w-full justify-between font-normal', className)}
        >
          {selectedOption ? (
            <span className="truncate">{selectedOption.label}</span>
          ) : (
            <span className="text-muted-foreground truncate">{placeholder}</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        {/* The input drops its own ring, so the row carries the focus indicator. */}
        <div className="flex items-center rounded-t-md border-b px-3 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <Input
            aria-label={searchPlaceholder}
            className="flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden border-0 focus-visible:ring-0 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
            placeholder={searchPlaceholder}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="max-h-80 overflow-y-auto overscroll-contain p-1">
          {filteredOptions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {filteredOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    // The ring tells the focused option apart from the selected one, which
                    // shares the accent background.
                    'relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring text-left',
                    value === option.value && 'bg-accent text-accent-foreground'
                  )}
                  aria-pressed={value === option.value}
                  onClick={() => handleSelect(option.value)}
                >
                  <span className="flex flex-col gap-0.5 w-full">
                    <span className="truncate">{option.label}</span>
                    {option.description && (
                      <span className="font-mono text-xs text-muted-foreground truncate">
                        {option.description}
                      </span>
                    )}
                  </span>
                  <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                    {value === option.value && <Check className="h-4 w-4" />}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
