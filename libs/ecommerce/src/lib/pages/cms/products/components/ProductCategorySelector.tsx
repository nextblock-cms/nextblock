'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { Check, ChevronsUpDown, Search, X, Loader2 } from 'lucide-react';
import { cn } from '@nextblock-cms/utils';
import {
  Badge,
  Button,
  Input,
  Checkbox,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@nextblock-cms/ui';
import { createCategoryAction } from '../server-actions';
import { toast } from 'sonner';

interface CategoryOption {
  id: string;
  name: string;
  slug: string;
}

interface ProductCategorySelectorProps {
  categories: CategoryOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
}

export function ProductCategorySelector({
  categories = [],
  selectedIds = [],
  onChange,
  placeholder = 'Select categories...',
}: ProductCategorySelectorProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [localCategories, setLocalCategories] = useState<CategoryOption[]>(categories);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    setLocalCategories(categories);
  }, [categories]);

  const selectedCategories = useMemo(() => {
    return localCategories.filter((cat) => selectedIds.includes(cat.id));
  }, [localCategories, selectedIds]);

  const filteredCategories = useMemo(() => {
    if (!searchQuery) return localCategories;
    const query = searchQuery.toLowerCase();
    return localCategories.filter(
      (cat) =>
        cat.name.toLowerCase().includes(query) ||
        cat.slug.toLowerCase().includes(query)
    );
  }, [localCategories, searchQuery]);

  const query = searchQuery.trim();
  const showCreateOption = useMemo(() => {
    if (!query) return false;
    const lowerQuery = query.toLowerCase();
    return !localCategories.some((cat) => cat.name.toLowerCase() === lowerQuery);
  }, [localCategories, query]);

  const handleCreateCategory = async () => {
    if (!query) return;
    setIsCreating(true);
    try {
      const res = await createCategoryAction({ name: query });
      if (res.success && res.category) {
        const newCat = {
          id: res.category.id,
          name: res.category.name,
          slug: res.category.slug,
        };
        setLocalCategories((prev) => [...prev, newCat]);
        onChange([...selectedIds, newCat.id]);
        setSearchQuery('');
        toast.success(`Category "${newCat.name}" created successfully.`);
      } else {
        toast.error(res.error || 'Failed to create category.');
      }
    } catch (err: any) {
      toast.error(err.message || 'An error occurred while creating category.');
    } finally {
      setIsCreating(false);
    }
  };

  const handleToggle = (categoryId: string) => {
    const nextIds = selectedIds.includes(categoryId)
      ? selectedIds.filter((id) => id !== categoryId)
      : [...selectedIds, categoryId];
    onChange(nextIds);
  };

  const handleRemove = (categoryId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(selectedIds.filter((id) => id !== categoryId));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5 min-h-[32px] p-1 border rounded-md bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
        {selectedCategories.length === 0 ? (
          <span className="text-xs text-muted-foreground self-center px-2 py-1 select-none">
            No categories selected.
          </span>
        ) : (
          selectedCategories.map((cat) => (
            <Badge
              key={cat.id}
              variant="secondary"
              className="pl-2 pr-1.5 py-0.5 text-xs flex items-center gap-1 bg-amber-500/10 text-amber-800 dark:text-amber-300 border border-amber-500/20 rounded-full"
            >
              {cat.name}
              <button
                type="button"
                onClick={(e) => handleRemove(cat.id, e)}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-amber-500/20 hover:text-amber-950 dark:hover:text-amber-50 transition-colors cursor-pointer"
                aria-label={`Remove ${cat.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))
        )}
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between h-8 text-xs font-normal"
          >
            <span className="truncate">
              {selectedIds.length > 0
                ? `${selectedIds.length} categor${selectedIds.length === 1 ? 'y' : 'ies'} selected`
                : placeholder}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
          <div className="flex items-center border-b px-3">
            <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
            <Input
              className="flex h-9 w-full rounded-md bg-transparent py-2 text-xs outline-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
              placeholder="Search categories..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          {showCreateOption && (
            <div className="border-b border-border/50 p-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start text-xs h-8 text-amber-600 dark:text-amber-400 hover:text-amber-700 hover:bg-amber-500/10 cursor-pointer"
                onClick={handleCreateCategory}
                disabled={isCreating}
              >
                {isCreating ? (
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                ) : (
                  <span className="font-bold mr-1.5">+</span>
                )}
                Create category "{query}"
              </Button>
            </div>
          )}
          <div className="max-h-60 overflow-y-auto p-1">
            {filteredCategories.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                No categories found.
              </p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {filteredCategories.map((cat) => {
                  const isChecked = selectedIds.includes(cat.id);
                  return (
                    <div
                      key={cat.id}
                      onClick={() => handleToggle(cat.id)}
                      className={cn(
                        "relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-xs outline-none hover:bg-accent hover:text-accent-foreground text-left transition-colors",
                        isChecked && "bg-accent/40 font-medium"
                      )}
                    >
                      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center pointer-events-none">
                        <Checkbox
                          checked={isChecked}
                          tabIndex={-1}
                          aria-label={`Toggle ${cat.name}`}
                          className="h-3.5 w-3.5"
                        />
                      </span>
                      <span className="flex flex-col">
                        <span>{cat.name}</span>
                        <span className="font-mono text-[9px] text-muted-foreground leading-none">
                          /{cat.slug}
                        </span>
                      </span>
                      {isChecked && (
                        <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                          <Check className="h-3.5 w-3.5 text-primary" />
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
