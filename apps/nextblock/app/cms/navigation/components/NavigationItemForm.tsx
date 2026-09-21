// app/cms/navigation/components/NavigationItemForm.tsx
"use client";

import React, { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@nextblock-cms/ui";
import { Spinner, Alert, AlertDescription, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@nextblock-cms/ui";
import { Info } from "lucide-react";
import { Input } from "@nextblock-cms/ui";
import { Label } from "@nextblock-cms/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@nextblock-cms/ui";
import type { Database } from "@nextblock-cms/db";
import { useAuth } from '../../../../context/AuthContext';
import { useHotkeys } from '../../../../hooks/use-hotkeys';

type NavigationItem = Database['public']['Tables']['navigation_items']['Row'];
type MenuLocation = Database['public']['Enums']['menu_location'];
type Language = Database['public']['Tables']['languages']['Row'];
type Page = Database['public']['Tables']['pages']['Row'];

interface NavigationItemFormProps {
  item?: NavigationItem | null;
  formAction: (formData: FormData) => Promise<{ error?: string } | void>;
  actionButtonText?: string;
  isEditing?: boolean;
  languages: Language[];
  parentItems: (Pick<NavigationItem, 'id' | 'label' | 'translation_group_id' | 'language_id' | 'parent_id'> & { menu_key: MenuLocation | null })[];
  pages: Pick<Page, 'id' | 'title' | 'slug' | 'language_id'>[];
}

export default function NavigationItemForm({
  item,
  formAction,
  actionButtonText = "Save Item",
  isEditing = false,
  languages,
  parentItems,
  pages,
}: NavigationItemFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const { isAdmin, isLoading: authLoading } = useAuth();

  // For creating a new translation based on an existing item
  const fromTranslationGroupId = searchParams.get("from_translation_group_id");
  const targetLanguageIdForTranslation = searchParams.get("target_language_id_for_translation");
  const initialMenuKeyFromParam = searchParams.get("menu_key") as MenuLocation | null;
  const originalLabelFromParam = searchParams.get("original_label");


  const [label, setLabel] = useState(item?.label || (originalLabelFromParam ? `[Translate] ${originalLabelFromParam}` : ""));
  const [url, setUrl] = useState(item?.url || (originalLabelFromParam ? "#" : "")); // Default to # if translating
  const [languageId, setLanguageId] = useState<string>(
    targetLanguageIdForTranslation || item?.language_id?.toString() || ""
  );
  const [menuKey, setMenuKey] = useState<MenuLocation | "">(
    initialMenuKeyFromParam || item?.menu_key || "HEADER"
  );
  const [order, setOrder] = useState<string>(item?.order?.toString() || "0");
  const [parentId, setParentId] = useState<string>(item?.parent_id?.toString() || "");
  const [pageId, setPageId] = useState<string>(item?.page_id?.toString() || "");

  const [availableLanguages] = useState<Language[]>(languages);
  const [availablePages, setAvailablePages] = useState<Pick<Page, 'id' | 'title' | 'slug'>[]>([]);
  const [availableParentItems, setAvailableParentItems] = useState<(Pick<NavigationItem, 'id' | 'label' | 'translation_group_id'> & { menu_key: MenuLocation | null })[]>([]);
  const [dataLoading] = useState(false);
  const [formMessage, setFormMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  useEffect(() => {
    const successMessage = searchParams.get('success');
    const errorMessage = searchParams.get('error');
    if (successMessage) setFormMessage({ type: 'success', text: decodeURIComponent(successMessage) });
    else if (errorMessage) setFormMessage({ type: 'error', text: decodeURIComponent(errorMessage) });
  }, [searchParams]);

  useEffect(() => {
    if (!isEditing && !languageId && !targetLanguageIdForTranslation && languages.length > 0) {
      const defaultLang = languages.find(l => l.is_default) || languages[0];
      if (defaultLang) setLanguageId(defaultLang.id.toString());
    }
  }, [isEditing, languageId, targetLanguageIdForTranslation, languages]);

  useEffect(() => {
    const currentLangId = languageId ? parseInt(languageId, 10) : null;
    if (currentLangId) {
      const filteredPages = pages.filter(p => p.language_id === currentLangId);
      setAvailablePages(filteredPages);

      const filteredParentItems = parentItems.filter(p => p.language_id === currentLangId && p.id !== item?.id);
      setAvailableParentItems(filteredParentItems);
    } else {
      setAvailablePages([]);
      setAvailableParentItems([]);
    }
  }, [languageId, pages, parentItems, item?.id]);

  const handlePageSelect = (selectedPageId: string) => {
    setPageId(selectedPageId);
    const selectedPage = availablePages.find(p => p.id.toString() === selectedPageId);
    if (selectedPage) {
      setUrl(`/${selectedPage.slug}`);
    } else if (selectedPageId === "___NONE___") {
      setUrl("#"); // Reset URL if "None" is selected, or keep previous manual URL
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormMessage(null);
    const formData = new FormData(event.currentTarget);

    // Append translation group ID if creating a new translation from an existing group
    if (fromTranslationGroupId && !isEditing) {
        formData.append("from_translation_group_id", fromTranslationGroupId);
    }
    if (targetLanguageIdForTranslation && !isEditing) {
        formData.append("target_language_id_for_translation", targetLanguageIdForTranslation);
    }


    startTransition(async () => {
      const result = await formAction(formData);
      if (result?.error) setFormMessage({ type: 'error', text: result.error });
    });
  };

  // Hooks must run on every render, so they sit above the early returns below (see
  // MediaEditForm): otherwise the hook count changes once auth or data finish loading.
  const formRef = React.useRef<HTMLFormElement>(null);
  useHotkeys('ctrl+s', () => formRef.current?.requestSubmit());

  if (authLoading || !isAdmin) {
    return <div>Access Denied. Admin role required.</div>;
  }
  if (dataLoading && !item) return <div>Loading form data...</div>; // Show loading only if not editing an existing item with data

  const menuLocations: MenuLocation[] = ['HEADER', 'FOOTER', 'SIDEBAR'];

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-6">
      {formMessage && (
        <Alert variant={formMessage.type === 'success' ? 'success' : 'destructive'}>
           <AlertDescription>{formMessage.text}</AlertDescription>
        </Alert>
      )}

      {/* Hidden input for from_translation_group_id if present in URL params and not editing */}
      {!isEditing && fromTranslationGroupId && (
        <input type="hidden" name="from_translation_group_id" value={fromTranslationGroupId} />
      )}
      {/* Hidden input for target_language_id_for_translation if present and not editing */}
       {!isEditing && targetLanguageIdForTranslation && (
        <input type="hidden" name="target_language_id_for_translation" value={targetLanguageIdForTranslation} />
      )}


      <div>
        <Label htmlFor="label">Label</Label>
        <Input id="label" name="label" value={label} onChange={(e) => setLabel(e.target.value)} required className="mt-1" />
      </div>
      <div>
        <Label htmlFor="page_id">Link to Internal Page (Optional)</Label>
        <Select name="page_id" value={pageId} onValueChange={handlePageSelect} disabled={!languageId}>
          <SelectTrigger className="mt-1"><SelectValue placeholder="None (Manual URL)" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="___NONE___">None (Manual URL)</SelectItem>
            {availablePages.map((p) => (
              <SelectItem key={p.id} value={p.id.toString()}>{p.title} ({p.slug})</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">Selecting a page will auto-fill the URL (can be overridden). Requires language to be selected first.</p>
      </div>
      <div>
        <Label htmlFor="url">URL</Label>
        <Input id="url" name="url" value={url} onChange={(e) => setUrl(e.target.value)} required className="mt-1" placeholder="/about-us or https://example.com" />
      </div>
      <div>
        <Label htmlFor="language_id">Language</Label>
        <Select
            name="language_id"
            value={languageId}
            onValueChange={(val) => {
                setLanguageId(val);
                // Reset page and parent item selection if language changes, as they are language-specific
                setPageId("");
                setParentId("");
                if (url.startsWith("/")) setUrl("#"); // Reset relative URL if it was page-linked
            }}
            required
            disabled={isEditing && !!targetLanguageIdForTranslation} // Disable if creating a specific translation or editing
        >
          <SelectTrigger className="mt-1"><SelectValue placeholder="Select language" /></SelectTrigger>
          <SelectContent>
            {availableLanguages.map((lang) => (
              <SelectItem key={lang.id} value={lang.id.toString()}>{lang.name} ({lang.code})</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <div className="flex items-center gap-2 mb-2">
            <Label htmlFor="menu_key">Menu Location</Label>
            <TooltipProvider>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Info className="h-4 w-4 text-muted-foreground opacity-70 cursor-pointer" />
                    </TooltipTrigger>
                    <TooltipContent>
                        <p>Where this item will appear in the site layout.</p>
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
        </div>
        <Select
            name="menu_key"
            value={menuKey}
            defaultValue="HEADER"
            onValueChange={(val) => {
                setMenuKey(val as MenuLocation);
                setParentId(""); // Reset parent if menu key changes
            }}
            required
            disabled={isEditing && !!initialMenuKeyFromParam} // Disable if creating translation for specific menu
        >
          <SelectTrigger className="mt-1"><SelectValue placeholder="Select menu location" /></SelectTrigger>
          <SelectContent>
            {menuLocations.map((loc) => (
              <SelectItem key={loc} value={loc}>{loc.charAt(0) + loc.slice(1).toLowerCase()}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor="order">Order</Label>
        <Input id="order" name="order" type="number" value={order} onChange={(e) => setOrder(e.target.value)} required className="mt-1" />
      </div>
      <div>
        <Label htmlFor="parent_id">Parent Item (Optional)</Label>
        <Select name="parent_id" value={parentId} onValueChange={setParentId} disabled={!languageId || !menuKey}>
          <SelectTrigger className="mt-1"><SelectValue placeholder="None (Top Level)" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="___NONE___">None (Top Level)</SelectItem>
            {availableParentItems
              .filter(p => p.menu_key === menuKey)
              .map((parent) => (
              <SelectItem key={parent.id} value={parent.id.toString()}>{parent.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
         <p className="text-xs text-muted-foreground mt-1">Parents must be in the same language and menu location.</p>
      </div>
      <div className="flex justify-end space-x-3">
        <Button type="button" variant="outline" onClick={() => router.push("/cms/navigation")} disabled={isPending}>Cancel</Button>
        <Button type="submit" disabled={isPending || dataLoading || !languageId || !menuKey}>
          {isPending ? (
             <>
               <Spinner className="mr-2 h-4 w-4" /> Saving...
             </>
           ) : (
             actionButtonText
           )}
        </Button>
      </div>
    </form>
  );
}
