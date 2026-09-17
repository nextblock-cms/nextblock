"use client";

import * as React from "react";
import { Check, Droplet, Pipette, RotateCcw } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Label } from "./label";
import { Input } from "./input";
import { Button } from "./button";
import {
  cn,
  contrastRatio,
  formatHsla,
  formatRgba,
  normalizeHex,
  rateContrast,
  resolveCssColor,
  rgbaToHex,
  rgbaToHsla,
  type Rgba,
} from "@nextblock-cms/utils";

/** A design-token swatch — stored by keyword so it keeps following the theme. */
export interface ColorTokenOption {
  /** Value persisted in block content, e.g. `"primary"`. */
  value: string;
  label: string;
  /** CSS colour used to paint the swatch, e.g. `"hsl(var(--primary))"`. */
  cssColor: string;
}

export interface ColorFieldProps {
  /** Either a token `value` from `tokens`, or any CSS colour string. */
  value?: string;
  onChange: (value: string | undefined) => void;
  label?: string;
  /** Helper text under the label. */
  description?: string;
  /** Theme tokens offered before the custom picker. */
  tokens?: readonly ColorTokenOption[];
  /** Show a "clear" affordance that emits `undefined`. */
  allowClear?: boolean;
  clearLabel?: string;
  /** Text shown on the trigger when `value` is undefined. */
  placeholder?: string;
  /** Allow a transparency channel (stores 8-digit hex). */
  enableAlpha?: boolean;
  presets?: readonly string[];
  /**
   * CSS colour the chosen colour will sit on. When set, a live WCAG contrast
   * badge is shown so editors cannot ship unreadable text.
   */
  contrastAgainst?: string;
  /** WCAG large-text thresholds (>=24px, or >=18.66px bold). Headings qualify. */
  largeText?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  align?: "start" | "center" | "end";
}

interface EyeDropperResult {
  sRGBHex: string;
}
interface EyeDropperConstructor {
  new (): { open: (options?: { signal?: AbortSignal }) => Promise<EyeDropperResult> };
}

const RECENT_COLORS_KEY = "nextblock:recent-colors";
const MAX_RECENT_COLORS = 8;

function readRecentColors(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_COLORS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_RECENT_COLORS);
  } catch {
    return [];
  }
}

function pushRecentColor(color: string): string[] {
  const next = [color, ...readRecentColors().filter((entry) => entry !== color)].slice(0, MAX_RECENT_COLORS);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(next));
    } catch {
      /* Private mode / quota — recents are a convenience, never a hard failure. */
    }
  }
  return next;
}

/** A checkerboard so translucent swatches read as translucent, not as grey. */
const ALPHA_CHECKERBOARD =
  "repeating-conic-gradient(rgba(0,0,0,0.16) 0% 25%, transparent 0% 50%) 50% / 8px 8px";

const HexColorPicker = React.lazy(async () => {
  const mod = await import("react-colorful");
  return { default: mod.HexColorPicker };
});

const HexAlphaColorPicker = React.lazy(async () => {
  const mod = await import("react-colorful");
  return { default: mod.HexAlphaColorPicker };
});

/**
 * react-colorful's own class names contain double underscores, which Tailwind
 * arbitrary variants would mangle. The skin lives as plain CSS in
 * `libs/ui/src/styles/components.css` under this hook class instead.
 */
const PICKER_SKIN = "nb-color-picker";

const ColorField = React.forwardRef<HTMLButtonElement, ColorFieldProps>(function ColorField(
  {
    value,
    onChange,
    label,
    description,
    tokens = [],
    allowClear = true,
    clearLabel = "Default",
    placeholder = "Default",
    enableAlpha = false,
    presets = [],
    contrastAgainst,
    largeText = false,
    disabled = false,
    id,
    className,
    align = "start",
  },
  forwardedRef,
) {
  const reactId = React.useId();
  const fieldId = id ?? `color-field-${reactId}`;
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  const activeToken = React.useMemo(
    () => tokens.find((token) => token.value === value),
    [tokens, value],
  );
  const isCustom = Boolean(value) && !activeToken;

  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<"theme" | "custom">(isCustom ? "custom" : "theme");
  const [recent, setRecent] = React.useState<string[]>([]);
  const [hexDraft, setHexDraft] = React.useState("");
  const [hexInvalid, setHexInvalid] = React.useState(false);
  const [supportsEyeDropper, setSupportsEyeDropper] = React.useState(false);

  // The colour the custom picker operates on. Falls back to the resolved token
  // colour so switching Theme -> Custom starts from what you can already see.
  const [customHex, setCustomHex] = React.useState<string>("#3B82F6");

  const displayCssColor = activeToken?.cssColor ?? (isCustom ? value : undefined);

  // Feature detection has to wait for the browser: reading `window` during render would
  // differ between the server and the client.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupportsEyeDropper(typeof window !== "undefined" && "EyeDropper" in window);
  }, []);

  // Resync local state whenever the popover opens or the value changes upstream.
  React.useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecent(readRecentColors());
    setMode(isCustom ? "custom" : "theme");
    const seed =
      (isCustom && value ? normalizeHex(value) : null) ??
      (displayCssColor
        ? (() => {
            const resolved = resolveCssColor(displayCssColor, triggerRef.current);
            return resolved ? rgbaToHex(resolved, enableAlpha) : null;
          })()
        : null);
    if (seed) setCustomHex(seed);
    setHexDraft(seed ?? customHex);
    setHexInvalid(false);
    // customHex is intentionally excluded: it is the value being seeded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value, isCustom, displayCssColor, enableAlpha]);

  const commitCustom = React.useCallback(
    (hex: string) => {
      const normalized = normalizeHex(hex);
      if (!normalized) return;
      setCustomHex(normalized);
      onChange(normalized);
    },
    [onChange],
  );

  const handlePickerChange = React.useCallback(
    (next: string) => {
      setHexDraft(normalizeHex(next) ?? next);
      setHexInvalid(false);
      commitCustom(next);
    },
    [commitCustom],
  );

  // Recents are recorded on close, not on every drag frame.
  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen && value && !tokens.some((token) => token.value === value)) {
        setRecent(pushRecentColor(value));
      }
    },
    [tokens, value],
  );

  const handleEyeDropper = React.useCallback(async () => {
    const ctor = (window as unknown as { EyeDropper?: EyeDropperConstructor }).EyeDropper;
    if (!ctor) return;
    try {
      const result = await new ctor().open();
      handlePickerChange(result.sRGBHex);
    } catch {
      /* The user dismissed the eyedropper — nothing to do. */
    }
  }, [handlePickerChange]);

  // --- Live readouts -------------------------------------------------------
  const [resolved, setResolved] = React.useState<Rgba | null>(null);
  const [backdrop, setBackdrop] = React.useState<Rgba | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setResolved(displayCssColor ? resolveCssColor(displayCssColor, triggerRef.current) : null);
    setBackdrop(contrastAgainst ? resolveCssColor(contrastAgainst, triggerRef.current) : null);
  }, [open, displayCssColor, contrastAgainst]);

  const contrast = React.useMemo(() => {
    if (!resolved || !backdrop) return null;
    const ratio = contrastRatio(resolved, backdrop);
    return { ratio, rating: rateContrast(ratio, largeText) };
  }, [resolved, backdrop, largeText]);

  const triggerText = activeToken?.label ?? (isCustom ? (normalizeHex(value ?? "") ?? value) : placeholder);

  return (
    <div className={cn("space-y-1.5", className)}>
      {label ? (
        <Label htmlFor={fieldId} className="text-sm">
          {label}
        </Label>
      ) : null}

      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            id={fieldId}
            ref={(node) => {
              triggerRef.current = node;
              if (typeof forwardedRef === "function") forwardedRef(node);
              else if (forwardedRef) forwardedRef.current = node;
            }}
            type="button"
            disabled={disabled}
            aria-label={label ? `${label}: ${triggerText}` : `Colour: ${triggerText}`}
            className={cn(
              "flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-2 text-sm shadow-sm transition-colors",
              "hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <span
              className="h-5 w-5 shrink-0 rounded border border-border/70"
              style={{ background: ALPHA_CHECKERBOARD }}
            >
              <span
                className="block h-full w-full rounded-[3px]"
                style={displayCssColor ? { backgroundColor: displayCssColor } : undefined}
              >
                {displayCssColor ? null : (
                  // Diagonal slash = "no colour set, inherit from the theme".
                  <svg viewBox="0 0 20 20" className="h-full w-full text-muted-foreground/60" aria-hidden>
                    <line x1="2" y1="18" x2="18" y2="2" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                )}
              </span>
            </span>
            <span className={cn("truncate", !value && "text-muted-foreground")}>{triggerText}</span>
            <Droplet className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </PopoverTrigger>

        <PopoverContent
          align={align}
          side="bottom"
          sideOffset={6}
          collisionPadding={12}
          // Last-resort guard: if the viewport is short enough that even the
          // two-column layout does not fit, scroll inside the popover rather
          // than letting it overflow off the top of the screen.
          className="max-h-[min(70vh,26rem)] w-[min(21rem,calc(100vw-1.5rem))] overflow-y-auto p-3"
        >
          <div className="space-y-2.5">
            {description ? <p className="text-[11px] text-muted-foreground">{description}</p> : null}

            {tokens.length > 0 ? (
              <div
                role="tablist"
                aria-label="Colour source"
                className="inline-flex w-full items-center gap-1 rounded-md bg-muted/60 p-1"
              >
                {(["theme", "custom"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={mode === tab}
                    onClick={() => setMode(tab)}
                    className={cn(
                      "flex-1 rounded px-2 py-1 text-xs font-medium capitalize transition-colors",
                      mode === tab
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            ) : null}

            {tokens.length > 0 && mode === "theme" ? (
              <div className="flex flex-wrap gap-1.5">
                {tokens.map((token) => {
                  const selected = token.value === value;
                  return (
                    <button
                      key={token.value}
                      type="button"
                      title={token.label}
                      aria-label={token.label}
                      aria-pressed={selected}
                      onClick={() => {
                        onChange(token.value);
                        setOpen(false);
                      }}
                      className={cn(
                        "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-transform hover:scale-105",
                        selected ? "border-ring ring-2 ring-ring/40" : "border-border/70",
                      )}
                      style={{ backgroundColor: token.cssColor }}
                    >
                      {/* White glyph + hard shadow so the tick reads on any swatch. */}
                      {selected ? (
                        <Check className="h-4 w-4 text-white drop-shadow-[0_0_1.5px_rgba(0,0,0,0.9)]" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {mode === "custom" || tokens.length === 0 ? (
              // Two columns: the picker is the tall element, so everything else
              // sits beside it rather than under it. Keeps the popover short
              // enough to open below its trigger instead of flipping off-screen.
              <div className="grid grid-cols-[148px_minmax(0,1fr)] gap-2.5">
                <React.Suspense fallback={<div className="h-38 animate-pulse rounded-lg bg-muted" />}>
                  <div className={PICKER_SKIN}>
                    {enableAlpha ? (
                      <HexAlphaColorPicker color={customHex} onChange={handlePickerChange} />
                    ) : (
                      <HexColorPicker color={customHex} onChange={handlePickerChange} />
                    )}
                  </div>
                </React.Suspense>

                <div className="flex min-w-0 flex-col gap-2">
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={hexDraft}
                      spellCheck={false}
                      aria-label="Hex colour"
                      onChange={(event) => {
                        const next = event.target.value;
                        setHexDraft(next);
                        const normalized = normalizeHex(next);
                        if (normalized) {
                          setHexInvalid(false);
                          commitCustom(normalized);
                        } else {
                          setHexInvalid(true);
                        }
                      }}
                      onBlur={() => {
                        if (hexInvalid) {
                          setHexDraft(customHex);
                          setHexInvalid(false);
                        }
                      }}
                      className={cn(
                        "h-8 min-w-0 flex-1 px-2 font-mono text-xs uppercase",
                        hexInvalid && "border-destructive focus-visible:ring-destructive",
                      )}
                      placeholder="#000000"
                    />
                    {supportsEyeDropper ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={handleEyeDropper}
                        title="Pick a colour from the screen"
                        aria-label="Pick a colour from the screen"
                      >
                        <Pipette className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>

                  {resolved ? (
                    <dl className="space-y-0.5 text-[10px] leading-tight text-muted-foreground">
                      <div className="truncate font-mono" title={formatRgba(resolved)}>
                        {formatRgba(resolved)}
                      </div>
                      <div className="truncate font-mono" title={formatHsla(rgbaToHsla(resolved))}>
                        {formatHsla(rgbaToHsla(resolved))}
                      </div>
                    </dl>
                  ) : null}

                  {presets.length > 0 ? (
                    <SwatchRow title="Presets" colors={presets} onPick={handlePickerChange} />
                  ) : null}
                  {recent.length > 0 ? (
                    <SwatchRow title="Recent" colors={recent} onPick={handlePickerChange} />
                  ) : null}
                </div>
              </div>
            ) : null}

            {mode === "theme" && resolved && tokens.length > 0 ? (
              <p className="truncate font-mono text-[10px] text-muted-foreground" title={formatRgba(resolved)}>
                {formatRgba(resolved)}
              </p>
            ) : null}

            {contrast ? (
              <div
                className={cn(
                  "flex items-center justify-between rounded-md px-2 py-1.5 text-[11px]",
                  contrast.rating === "Fail"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted/60 text-muted-foreground",
                )}
              >
                <span>Contrast {contrast.ratio}:1</span>
                <span className="font-semibold">{contrast.rating}</span>
              </div>
            ) : null}

            {allowClear ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-full justify-start text-xs"
                disabled={value === undefined}
                onClick={() => {
                  onChange(undefined);
                  setOpen(false);
                }}
              >
                <RotateCcw className="mr-1.5 h-3 w-3" />
                {clearLabel}
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
});

function SwatchRow({
  title,
  colors,
  onPick,
}: {
  title: string;
  colors: readonly string[];
  onPick: (color: string) => void;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="flex flex-wrap gap-1">
        {colors.map((color) => (
          <button
            key={color}
            type="button"
            title={color}
            aria-label={`${title} colour ${color}`}
            onClick={() => onPick(color)}
            className="h-5 w-5 rounded border border-border/70 transition-transform hover:scale-110"
            style={{ background: ALPHA_CHECKERBOARD }}
          >
            <span className="block h-full w-full rounded-[2px]" style={{ backgroundColor: color }} />
          </button>
        ))}
      </div>
    </div>
  );
}

ColorField.displayName = "ColorField";

export { ColorField };
