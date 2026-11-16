"use client";

import { Button } from "@nextblock-cms/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@nextblock-cms/ui/dropdown-menu";
import { Laptop } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { useTranslations } from "@nextblock-cms/utils/translations-context";
import { useThemeCatalog } from "../context/ThemeCatalogContext";
import { ThemeIcon } from "./theme-icon";

const ICON_SIZE = 16;

const ThemeSwitcher = () => {
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme } = useTheme();
  const { t } = useTranslations();
  const themes = useThemeCatalog();

  // useEffect only runs on the client, so now we can safely show the UI
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  const active = themes.find((entry) => entry.slug === theme);

  /**
   * Built-in slugs keep their existing translation keys so no copy is lost;
   * admin-created themes fall back to the name stored on the row.
   */
  const labelFor = (slug: string, name: string) => {
    const builtin: Record<string, string> = {
      light: "theme_light",
      dark: "theme_dark",
      vibrant: "theme_vibrant",
    };
    const key = builtin[slug];
    if (!key) return name;
    const translated = t(key);
    return translated === key ? name : translated;
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size={"sm"} aria-label={t('theme_switcher')}>
          {active ? (
            <ThemeIcon name={active.icon} size={ICON_SIZE} className="text-muted-foreground" />
          ) : (
            <Laptop size={ICON_SIZE} className="text-muted-foreground" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-content" align="start">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(e) => setTheme(e)}
        >
          {themes.map((entry) => (
            <DropdownMenuRadioItem key={entry.slug} className="flex gap-2" value={entry.slug}>
              <ThemeIcon name={entry.icon} size={ICON_SIZE} className="text-muted-foreground" />{" "}
              <span>{labelFor(entry.slug, entry.name)}</span>
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuRadioItem className="flex gap-2" value="system">
            <Laptop size={ICON_SIZE} className="text-muted-foreground" />{" "}
            <span>{t('theme_system')}</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export { ThemeSwitcher };
