'use client';

import React, { useEffect, useId, useState, useTransition } from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Checkbox,
  ColorField,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@nextblock-cms/ui';
import { cn } from '@nextblock-cms/utils';
import type { CortexSiteBrief } from '@nextblock-cms/cortex';
import {
  AlertTriangle,
  Building2,
  Contact,
  Eye,
  FileText,
  Languages,
  LayoutTemplate,
  Loader2,
  MessageCircleMore,
  Palette,
  Plus,
  Save,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  SITE_BRIEF_GOAL_OPTIONS,
  SITE_BRIEF_NOTES_MAX_LENGTH,
  SITE_BRIEF_PAGE_OPTIONS,
  SITE_BRIEF_TONE_OPTIONS,
  buildSiteBriefNotes,
  type SiteBriefFormValues,
} from '../../../../../lib/cortex-ai/site-brief-form';
import { saveSiteBriefFromFormAction } from './brief-actions';

/**
 * The site brief as one scrolling form.
 *
 * This is the questionnaire Cortex used to run in chat, one question at a time.
 * Written down as a form it takes a couple of minutes, can be answered in any order,
 * and saves a complete brief in one go, so the build conversation starts at the
 * plan instead of at "what does your business do?". Every section is short and
 * every field beyond the name and description is optional.
 */

type SiteBriefFormProps = {
  activeLanguages: Array<{ code: string; name: string; isDefault: boolean }>;
  initialValues: SiteBriefFormValues;
  /** A saved brief is being edited: "skip" means "cancel, keep the saved brief". */
  isEditing?: boolean;
  /** Reports every change so the parent can keep the draft across an unmount. */
  onChange?: (values: SiteBriefFormValues) => void;
  onSaved: (brief: CortexSiteBrief) => void;
  onSkip: () => void;
};

type SiteType = SiteBriefFormValues['site_type'];
type LogoChoice = SiteBriefFormValues['brand']['logo'];
type FieldErrors = Partial<Record<string, string>>;

const SITE_TYPE_OPTIONS: ReadonlyArray<{ value: SiteType; label: string; hint: string }> = [
  { hint: 'Everything on a single scrolling page.', label: 'One landing page', value: 'landing-page' },
  { hint: 'Home plus a few pages such as About, Services and Contact.', label: 'Several pages', value: 'multi-page' },
  { hint: 'Articles first, with a few pages around them.', label: 'Blog', value: 'blog' },
  { hint: 'Products, cart and checkout, plus the usual pages.', label: 'Online store', value: 'store' },
  { hint: 'Your work front and centre, with a way to get in touch.', label: 'Portfolio', value: 'portfolio' },
];

const LOGO_OPTIONS: ReadonlyArray<{ value: LogoChoice; label: string; hint: string }> = [
  { hint: 'Cortex uses a text logo until then.', label: "I'll upload it later", value: 'later' },
  { hint: 'A clean text logo in your colours.', label: 'No logo, make a text logo', value: 'none' },
  { hint: 'Upload it in Media once the site is built.', label: "I have one, I'll upload it now-ish", value: 'have' },
];

const SOCIAL_PLATFORMS = ['Instagram', 'Facebook', 'LinkedIn', 'X', 'TikTok', 'YouTube', 'Other'] as const;

const CUSTOM_PAGE_PREFIX = 'custom:';
const HTTP_URL_PATTERN = /^https?:\/\/\S+$/i;

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isKnownGoal(value: string): boolean {
  return SITE_BRIEF_GOAL_OPTIONS.some((option) => option.value === value);
}

function isKnownTone(value: string | undefined): boolean {
  return value !== undefined && (SITE_BRIEF_TONE_OPTIONS as ReadonlyArray<string>).includes(value);
}

/** A toggle chip: a button that announces its pressed state, so a keyboard reads it as a switch. */
function Chip({
  children,
  onClick,
  onRemove,
  pressed,
  removeLabel,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  onRemove?: () => void;
  pressed: boolean;
  removeLabel?: string;
}) {
  return (
    <span className="inline-flex items-stretch">
      <button
        aria-pressed={pressed}
        className={cn(
          'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          pressed
            ? 'border-primary bg-primary/10 font-medium text-primary'
            : 'border-input bg-background text-foreground hover:border-primary/50',
          onRemove && 'rounded-r-none border-r-0',
          !onClick && 'cursor-default'
        )}
        onClick={onClick}
        type="button"
      >
        {children}
      </button>
      {onRemove && (
        <button
          aria-label={removeLabel ?? 'Remove'}
          className={cn(
            'inline-flex items-center rounded-r-full border px-2 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            pressed ? 'border-primary bg-primary/10 text-primary' : 'border-input bg-background'
          )}
          onClick={onRemove}
          type="button"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </span>
  );
}

/** A small inline "add an entry" input: Enter adds, Escape cancels, never submits the form. */
function InlineAdd({
  autoFocus,
  id,
  label,
  onAdd,
  onCancel,
  placeholder,
}: {
  autoFocus?: boolean;
  id: string;
  label: string;
  onAdd: (value: string) => void;
  onCancel?: () => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState('');

  function commit() {
    const value = draft.trim();
    if (!value) return;
    onAdd(value);
    setDraft('');
  }

  return (
    <div className="flex w-full max-w-sm items-center gap-2">
      <Label className="sr-only" htmlFor={id}>
        {label}
      </Label>
      <Input
        autoFocus={autoFocus}
        className="h-9"
        id={id}
        maxLength={120}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape' && onCancel) {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder={placeholder}
        value={draft}
      />
      <Button className="h-9 shrink-0" disabled={!draft.trim()} onClick={commit} size="sm" type="button" variant="outline">
        <Plus className="mr-1 h-3.5 w-3.5" />
        Add
      </Button>
    </div>
  );
}

function Section({
  children,
  error,
  explainer,
  icon: Icon,
  optional,
  title,
}: {
  children: React.ReactNode;
  error?: string;
  explainer: string;
  icon: React.ElementType;
  optional?: boolean;
  title: string;
}) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
      <div className="space-y-1">
        <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold" id={headingId}>
          <Icon className="h-4 w-4 text-primary" aria-hidden />
          {title}
          {optional && (
            <Badge className="font-normal" variant="outline">
              Optional
            </Badge>
          )}
        </h3>
        <p className="text-sm text-muted-foreground">{explainer}</p>
      </div>
      {children}
      {error && <FieldError id={`${headingId}-error`} message={error} />}
    </section>
  );
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p className="text-xs text-destructive" id={id} role="alert">
      {message}
    </p>
  );
}

function Field({
  children,
  error,
  hint,
  htmlFor,
  label,
  required,
}: {
  children: React.ReactNode;
  error?: string;
  hint?: string;
  htmlFor: string;
  label: string;
  required?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs" htmlFor={htmlFor}>
        {label}
        {required ? (
          <span aria-hidden className="ml-0.5 text-destructive">
            *
          </span>
        ) : null}
      </Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      <FieldError id={`${htmlFor}-error`} message={error} />
    </div>
  );
}

function validate(values: SiteBriefFormValues): FieldErrors {
  const errors: FieldErrors = {};

  if (!values.business_name.trim()) errors['business_name'] = 'Give the business a name.';
  else if (values.business_name.trim().length > 160) errors['business_name'] = 'Keep the name under 160 characters.';

  if (!values.description.trim()) errors['description'] = 'Say what the business does, in a sentence or two.';
  else if (values.description.trim().length > 3000) errors['description'] = 'Keep the description under 3000 characters.';

  if (values.tagline && values.tagline.trim().length > 200) errors['tagline'] = 'Keep the tagline under 200 characters.';
  if (values.audience && values.audience.trim().length > 1000) errors['audience'] = 'Keep this under 1000 characters.';
  // The reference link is appended to the notes when the brief is stored, so the two
  // share the stored field's limit (mirrors `siteBriefFormSchema`).
  if ((buildSiteBriefNotes(values)?.length ?? 0) > SITE_BRIEF_NOTES_MAX_LENGTH) {
    errors['notes'] = values.reference_url?.trim()
      ? `Notes plus the reference link must stay under ${SITE_BRIEF_NOTES_MAX_LENGTH} characters.`
      : `Keep the notes under ${SITE_BRIEF_NOTES_MAX_LENGTH} characters.`;
  }
  if (values.goals.length > 10) errors['goals'] = 'Pick at most ten goals.';

  if (values.languages.length === 0) errors['languages'] = 'Choose at least one language.';
  else if (!values.languages.includes(values.primary_language)) {
    errors['primary_language'] = 'The primary language must be one of the languages you offer.';
  }

  const reference = values.reference_url?.trim();
  if (reference && !HTTP_URL_PATTERN.test(reference)) {
    errors['reference_url'] = 'Enter a full address starting with http:// or https://.';
  }

  const brokenSocial = values.contact.social.find((row) => !HTTP_URL_PATTERN.test(row.url.trim()));
  if (brokenSocial) errors['contact'] = `The ${brokenSocial.platform} link needs a full address starting with https://.`;

  return errors;
}

/** Trim everything, drop empty optional fields and blank social rows: what the server expects. */
function normalise(values: SiteBriefFormValues): SiteBriefFormValues {
  const optional = (value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };

  return {
    ...values,
    audience: optional(values.audience),
    brand: {
      ...values.brand,
      primary_color: values.brand.color_mode === 'custom' ? optional(values.brand.primary_color) : undefined,
      secondary_color: values.brand.color_mode === 'custom' ? optional(values.brand.secondary_color) : undefined,
      tone: optional(values.brand.tone),
    },
    business_name: values.business_name.trim(),
    contact: {
      address: optional(values.contact.address),
      email: optional(values.contact.email),
      hours: optional(values.contact.hours),
      phone: optional(values.contact.phone),
      social: values.contact.social
        .map((row) => ({ platform: row.platform.trim() || 'Other', url: row.url.trim() }))
        .filter((row) => row.url.length > 0),
    },
    description: values.description.trim(),
    goals: values.goals.map((goal) => goal.trim()).filter(Boolean),
    notes: optional(values.notes),
    pages: values.site_type === 'landing-page' ? [] : values.pages,
    reference_url: optional(values.reference_url),
    tagline: optional(values.tagline),
  };
}

const FIELD_INPUT_IDS: Record<string, string> = {
  audience: 'brief_audience',
  business_name: 'brief_business_name',
  description: 'brief_description',
  notes: 'brief_notes',
  reference_url: 'brief_reference_url',
  tagline: 'brief_tagline',
};

export function SiteBriefForm({
  activeLanguages,
  initialValues,
  isEditing = false,
  onChange,
  onSaved,
  onSkip,
}: SiteBriefFormProps) {
  const [values, setValues] = useState<SiteBriefFormValues>(initialValues);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    onChange?.(values);
  }, [onChange, values]);

  // Free-text "Other…" affordances. The entry itself lives in `values`; these only
  // remember whether the input is open.
  const [addingGoal, setAddingGoal] = useState(false);
  const [addingPage, setAddingPage] = useState(false);
  const [customTone, setCustomTone] = useState(() => Boolean(values.brand.tone) && !isKnownTone(values.brand.tone));

  const singleLanguage = activeLanguages.length === 1 ? activeLanguages[0] : null;
  const showsPages = values.site_type !== 'landing-page';
  const canSave = values.business_name.trim().length > 0 && values.description.trim().length > 0 && !isPending;

  function update<K extends keyof SiteBriefFormValues>(key: K, value: SiteBriefFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function updateBrand(patch: Partial<SiteBriefFormValues['brand']>) {
    setValues((current) => ({ ...current, brand: { ...current.brand, ...patch } }));
  }

  function updateContact(patch: Partial<SiteBriefFormValues['contact']>) {
    setValues((current) => ({ ...current, contact: { ...current.contact, ...patch } }));
    setFieldErrors((current) => {
      if (!current['contact']) return current;
      const next = { ...current };
      delete next['contact'];
      return next;
    });
  }

  function toggleGoal(goal: string) {
    update('goals', values.goals.includes(goal) ? values.goals.filter((entry) => entry !== goal) : [...values.goals, goal]);
  }

  function togglePage(page: string) {
    update('pages', values.pages.includes(page) ? values.pages.filter((entry) => entry !== page) : [...values.pages, page]);
  }

  function toggleLanguage(code: string, checked: boolean) {
    const languages = checked
      ? [...values.languages, code]
      : values.languages.filter((entry) => entry !== code);
    // Keep the active languages' order so "primary first" stays meaningful.
    const ordered = activeLanguages.map((language) => language.code).filter((entry) => languages.includes(entry));
    const primary = ordered.includes(values.primary_language) ? values.primary_language : (ordered[0] ?? '');

    setValues((current) => ({ ...current, languages: ordered, primary_language: primary }));
    setFieldErrors((current) => {
      const next = { ...current };
      delete next['languages'];
      delete next['primary_language'];
      return next;
    });
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const payload = normalise(
      singleLanguage
        ? { ...values, languages: [singleLanguage.code], primary_language: singleLanguage.code }
        : values
    );
    const errors = validate(payload);

    setMessage(null);
    setFieldErrors(errors);

    const firstError = Object.keys(errors)[0];
    if (firstError) {
      const inputId = FIELD_INPUT_IDS[firstError];
      if (inputId) document.getElementById(inputId)?.focus();
      return;
    }

    startTransition(async () => {
      const result = await saveSiteBriefFromFormAction(payload);

      if (!result.success) {
        setMessage(result.message);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      toast.success('Site brief saved.');
      onSaved(result.brief);
    });
  }

  return (
    <form className="space-y-4" noValidate onSubmit={submit}>
      {/* ───────────── Your business ───────────── */}
      <Section
        explainer="The two lines Cortex needs before anything else. Write the way you would tell a friend."
        icon={Building2}
        title="Your business"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field error={fieldErrors['business_name']} htmlFor="brief_business_name" label="Business name" required>
            <Input
              autoComplete="organization"
              autoFocus
              id="brief_business_name"
              maxLength={160}
              onChange={(event) => update('business_name', event.target.value)}
              placeholder="Maison Dupont"
              value={values.business_name}
            />
          </Field>
          <Field
            error={fieldErrors['tagline']}
            hint="Short and memorable; it goes under the name."
            htmlFor="brief_tagline"
            label="Tagline"
          >
            <Input
              id="brief_tagline"
              maxLength={200}
              onChange={(event) => update('tagline', event.target.value)}
              placeholder="Real bread, baked before sunrise"
              value={values.tagline ?? ''}
            />
          </Field>
        </div>
        <Field
          error={fieldErrors['description']}
          hint="What you do, for whom, and what makes you different. Two or three sentences are plenty."
          htmlFor="brief_description"
          label="What do you do?"
          required
        >
          <Textarea
            id="brief_description"
            maxLength={3000}
            onChange={(event) => update('description', event.target.value)}
            placeholder="Family-run bakery in Lyon; sourdough, pastries, custom cakes. Open since 1987, everything made on site."
            rows={4}
            value={values.description}
          />
        </Field>
      </Section>

      {/* ───────────── Visitors ───────────── */}
      <Section
        error={fieldErrors['goals']}
        explainer="Who comes to the site and what you want them to do. This decides the buttons and the order of the pages."
        icon={Eye}
        optional
        title="Visitors"
      >
        <Field
          error={fieldErrors['audience']}
          htmlFor="brief_audience"
          label="Who is the site for?"
        >
          <Input
            id="brief_audience"
            maxLength={1000}
            onChange={(event) => update('audience', event.target.value)}
            placeholder="Locals and tourists in the old town; event planners ordering cakes"
            value={values.audience ?? ''}
          />
        </Field>
        <div className="space-y-2">
          <p className="text-xs font-medium" id="brief_goals_label">
            What should a visitor do?
          </p>
          <div aria-labelledby="brief_goals_label" className="flex flex-wrap gap-2" role="group">
            {SITE_BRIEF_GOAL_OPTIONS.map((option) => (
              <Chip key={option.value} onClick={() => toggleGoal(option.value)} pressed={values.goals.includes(option.value)}>
                {option.label}
              </Chip>
            ))}
            {values.goals
              .filter((goal) => !isKnownGoal(goal))
              .map((goal) => (
                <Chip key={goal} onRemove={() => toggleGoal(goal)} pressed removeLabel={`Remove goal ${goal}`}>
                  {goal}
                </Chip>
              ))}
            <Chip onClick={() => setAddingGoal((open) => !open)} pressed={addingGoal}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Other…
            </Chip>
          </div>
          {addingGoal && (
            <InlineAdd
              autoFocus
              id="brief_goal_custom"
              label="Another goal"
              onAdd={(goal) => {
                if (!values.goals.includes(goal)) update('goals', [...values.goals, goal]);
                setAddingGoal(false);
              }}
              onCancel={() => setAddingGoal(false)}
              placeholder="Download our price list"
            />
          )}
        </div>
      </Section>

      {/* ───────────── Site shape ───────────── */}
      <Section
        error={fieldErrors['site_type'] ?? fieldErrors['pages']}
        explainer="How big a site you want. Home is always built; pick what goes around it."
        icon={LayoutTemplate}
        title="Site shape"
      >
        <RadioGroup
          aria-label="Site type"
          className="grid gap-2 sm:grid-cols-2"
          onValueChange={(value) => {
            const siteType = value as SiteType;
            setValues((current) => ({
              ...current,
              sells_online: siteType === 'store' ? true : current.sells_online,
              site_type: siteType,
            }));
          }}
          value={values.site_type}
        >
          {SITE_TYPE_OPTIONS.map((option) => {
            const selected = values.site_type === option.value;
            const id = `brief_site_type_${option.value}`;
            return (
              <label
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                  selected ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'hover:border-primary/50'
                )}
                htmlFor={id}
                key={option.value}
              >
                <RadioGroupItem className="mt-0.5" id={id} value={option.value} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            );
          })}
        </RadioGroup>

        {showsPages && (
          <div className="space-y-2">
            <p className="text-xs font-medium" id="brief_pages_label">
              Pages to build
            </p>
            <div aria-labelledby="brief_pages_label" className="flex flex-wrap gap-2" role="group">
              <Chip pressed>Home</Chip>
              {SITE_BRIEF_PAGE_OPTIONS.map((option) => (
                <Chip key={option.value} onClick={() => togglePage(option.value)} pressed={values.pages.includes(option.value)}>
                  {option.label}
                </Chip>
              ))}
              {values.pages
                .filter((page) => page.startsWith(CUSTOM_PAGE_PREFIX))
                .map((page) => {
                  const title = page.slice(CUSTOM_PAGE_PREFIX.length);
                  return (
                    <Chip key={page} onRemove={() => togglePage(page)} pressed removeLabel={`Remove page ${title}`}>
                      {title}
                    </Chip>
                  );
                })}
              <Chip onClick={() => setAddingPage((open) => !open)} pressed={addingPage}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Add a page…
              </Chip>
            </div>
            {addingPage && (
              <InlineAdd
                autoFocus
                id="brief_page_custom"
                label="Page title"
                onAdd={(title) => {
                  const entry = `${CUSTOM_PAGE_PREFIX}${titleCase(title)}`;
                  if (!values.pages.includes(entry)) update('pages', [...values.pages, entry]);
                  setAddingPage(false);
                }}
                onCancel={() => setAddingPage(false)}
                placeholder="Menu"
              />
            )}
          </div>
        )}
      </Section>

      {/* ───────────── Languages ───────────── */}
      <Section
        error={fieldErrors['languages'] ?? fieldErrors['primary_language']}
        explainer="Cortex writes every page in each language you tick. The primary one is what visitors see first."
        icon={Languages}
        title="Languages"
      >
        {singleLanguage ? (
          <p className="text-sm">
            <span className="font-medium">{singleLanguage.name}</span>{' '}
            <span className="font-mono text-xs text-muted-foreground">{singleLanguage.code}</span>
            <span className="text-muted-foreground"> — the only active language. Add more under Settings → Languages.</span>
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="flex flex-wrap gap-x-5 gap-y-2" role="group" aria-label="Languages to offer">
              {activeLanguages.map((language) => {
                const id = `brief_language_${language.code}`;
                return (
                  <div className="flex items-center gap-2" key={language.code}>
                    <Checkbox
                      checked={values.languages.includes(language.code)}
                      id={id}
                      onCheckedChange={(checked) => toggleLanguage(language.code, checked === true)}
                    />
                    <Label className="cursor-pointer text-sm font-normal" htmlFor={id}>
                      {language.name}{' '}
                      <span className="font-mono text-xs text-muted-foreground">{language.code}</span>
                    </Label>
                  </div>
                );
              })}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="brief_primary_language">
                Primary language
              </Label>
              <Select
                disabled={values.languages.length === 0}
                onValueChange={(value) => update('primary_language', value)}
                value={values.primary_language || undefined}
              >
                <SelectTrigger className="h-9 w-full sm:w-44" id="brief_primary_language">
                  <SelectValue placeholder="Tick a language first" />
                </SelectTrigger>
                <SelectContent>
                  {activeLanguages
                    .filter((language) => values.languages.includes(language.code))
                    .map((language) => (
                      <SelectItem key={language.code} value={language.code}>
                        {language.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </Section>

      {/* ───────────── Look and feel ───────────── */}
      <Section
        error={fieldErrors['brand']}
        explainer="Colours, mood and logo. Leave the colours to Cortex if you have none yet; you can change all of it later."
        icon={Palette}
        optional
        title="Look and feel"
      >
        <RadioGroup
          aria-label="Colours"
          className="grid gap-2 sm:grid-cols-2"
          onValueChange={(value) => updateBrand({ color_mode: value as 'auto' | 'custom' })}
          value={values.brand.color_mode}
        >
          {(
            [
              { hint: 'Cortex chooses a palette that fits your business and tone.', label: 'Pick colours for me', value: 'auto' },
              { hint: 'Give the brand colours you already use.', label: 'Use my colours', value: 'custom' },
            ] as const
          ).map((option) => {
            const selected = values.brand.color_mode === option.value;
            const id = `brief_color_mode_${option.value}`;
            return (
              <label
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                  selected ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'hover:border-primary/50'
                )}
                htmlFor={id}
                key={option.value}
              >
                <RadioGroupItem className="mt-0.5" id={id} value={option.value} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            );
          })}
        </RadioGroup>

        {values.brand.color_mode === 'custom' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <ColorField
              id="brief_primary_color"
              label="Primary colour"
              onChange={(value) => updateBrand({ primary_color: value })}
              placeholder="Pick or paste a hex code"
              presets={['#1E6F5C', '#1D4ED8', '#B91C1C', '#C2410C', '#7C3AED', '#0F172A']}
              value={values.brand.primary_color || undefined}
            />
            <ColorField
              id="brief_secondary_color"
              label="Secondary colour"
              onChange={(value) => updateBrand({ secondary_color: value })}
              placeholder="Optional accent"
              presets={['#F59E0B', '#10B981', '#38BDF8', '#F472B6', '#FACC15', '#E2E8F0']}
              value={values.brand.secondary_color || undefined}
            />
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
          <div className="space-y-1.5">
            <p className="text-xs font-medium" id="brief_color_scheme_label">
              Overall look
            </p>
            <div aria-labelledby="brief_color_scheme_label" className="inline-flex rounded-md border p-0.5" role="group">
              {(
                [
                  { label: 'Light', value: 'light' },
                  { label: 'Dark', value: 'dark' },
                ] as const
              ).map((option) => {
                const selected = values.brand.color_scheme === option.value;
                return (
                  <button
                    aria-pressed={selected}
                    className={cn(
                      'h-8 rounded px-4 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    )}
                    key={option.value}
                    onClick={() => updateBrand({ color_scheme: option.value })}
                    type="button"
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium" id="brief_tone_label">
              Tone of voice
            </p>
            <div aria-labelledby="brief_tone_label" className="flex flex-wrap gap-2" role="group">
              {SITE_BRIEF_TONE_OPTIONS.map((tone) => {
                const selected = !customTone && values.brand.tone === tone;
                return (
                  <Chip
                    key={tone}
                    onClick={() => {
                      setCustomTone(false);
                      updateBrand({ tone: selected ? undefined : tone });
                    }}
                    pressed={selected}
                  >
                    {titleCase(tone)}
                  </Chip>
                );
              })}
              <Chip
                onClick={() => {
                  const opening = !customTone;
                  // Opening the free-text input drops a preset tone; closing it keeps
                  // whatever was typed so far (it is still the tone).
                  if (opening && isKnownTone(values.brand.tone)) updateBrand({ tone: undefined });
                  setCustomTone(opening);
                }}
                pressed={customTone}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Other…
              </Chip>
            </div>
            {customTone && (
              <div className="max-w-sm">
                <Label className="sr-only" htmlFor="brief_tone_custom">
                  Describe the tone
                </Label>
                <Input
                  autoFocus
                  className="h-9"
                  id="brief_tone_custom"
                  maxLength={200}
                  onChange={(event) => updateBrand({ tone: event.target.value })}
                  placeholder="Warm and plain-spoken, a little cheeky"
                  value={isKnownTone(values.brand.tone) ? '' : (values.brand.tone ?? '')}
                />
              </div>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium" id="brief_logo_label">
            Logo
          </p>
          <RadioGroup
            aria-labelledby="brief_logo_label"
            className="grid gap-2 sm:grid-cols-3"
            onValueChange={(value) => updateBrand({ logo: value as LogoChoice })}
            value={values.brand.logo}
          >
            {LOGO_OPTIONS.map((option) => {
              const selected = values.brand.logo === option.value;
              const id = `brief_logo_${option.value}`;
              return (
                <label
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                    selected ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'hover:border-primary/50'
                  )}
                  htmlFor={id}
                  key={option.value}
                >
                  <RadioGroupItem className="mt-0.5" id={id} value={option.value} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium">{option.label}</span>
                    <span className="text-xs text-muted-foreground">{option.hint}</span>
                  </span>
                </label>
              );
            })}
          </RadioGroup>
        </div>
      </Section>

      {/* ───────────── Contact details ───────────── */}
      <Section
        error={fieldErrors['contact']}
        explainer="Shown on the contact page and footer. Leave blank anything you would rather not publish."
        icon={Contact}
        optional
        title="Contact details"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field htmlFor="brief_contact_email" label="Email">
            <Input
              autoComplete="email"
              id="brief_contact_email"
              inputMode="email"
              maxLength={200}
              onChange={(event) => updateContact({ email: event.target.value })}
              placeholder="hello@maisondupont.fr"
              type="email"
              value={values.contact.email ?? ''}
            />
          </Field>
          <Field htmlFor="brief_contact_phone" label="Phone">
            <Input
              autoComplete="tel"
              id="brief_contact_phone"
              inputMode="tel"
              maxLength={60}
              onChange={(event) => updateContact({ phone: event.target.value })}
              placeholder="+33 4 72 00 00 00"
              type="tel"
              value={values.contact.phone ?? ''}
            />
          </Field>
          <Field htmlFor="brief_contact_address" label="Address">
            <Input
              autoComplete="street-address"
              id="brief_contact_address"
              maxLength={400}
              onChange={(event) => updateContact({ address: event.target.value })}
              placeholder="12 rue de la République, 69002 Lyon"
              value={values.contact.address ?? ''}
            />
          </Field>
          <Field htmlFor="brief_contact_hours" label="Opening hours">
            <Input
              id="brief_contact_hours"
              maxLength={400}
              onChange={(event) => updateContact({ hours: event.target.value })}
              placeholder="Tue–Sat 7:00–19:00, Sun 7:00–13:00"
              value={values.contact.hours ?? ''}
            />
          </Field>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium">Social links</p>
          {values.contact.social.length > 0 && (
            <ul className="space-y-2">
              {values.contact.social.map((row, index) => (
                <li className="flex flex-wrap items-center gap-2 sm:flex-nowrap" key={index}>
                  <Label className="sr-only" htmlFor={`brief_social_platform_${index}`}>
                    Platform
                  </Label>
                  <Select
                    onValueChange={(platform) =>
                      updateContact({
                        social: values.contact.social.map((entry, i) => (i === index ? { ...entry, platform } : entry)),
                      })
                    }
                    value={row.platform}
                  >
                    <SelectTrigger className="h-9 w-full sm:w-36" id={`brief_social_platform_${index}`}>
                      <SelectValue placeholder="Platform" />
                    </SelectTrigger>
                    <SelectContent>
                      {SOCIAL_PLATFORMS.map((platform) => (
                        <SelectItem key={platform} value={platform}>
                          {platform}
                        </SelectItem>
                      ))}
                      {!(SOCIAL_PLATFORMS as ReadonlyArray<string>).includes(row.platform) && row.platform && (
                        <SelectItem value={row.platform}>{row.platform}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Label className="sr-only" htmlFor={`brief_social_url_${index}`}>
                      Link
                    </Label>
                    <Input
                      className="h-9 min-w-0 flex-1"
                      id={`brief_social_url_${index}`}
                      inputMode="url"
                      maxLength={2048}
                      onChange={(event) =>
                        updateContact({
                          social: values.contact.social.map((entry, i) =>
                            i === index ? { ...entry, url: event.target.value } : entry
                          ),
                        })
                      }
                      placeholder="https://instagram.com/maisondupont"
                      type="url"
                      value={row.url}
                    />
                    <Button
                      aria-label={`Remove ${row.platform} link`}
                      className="h-9 w-9 shrink-0"
                      onClick={() => updateContact({ social: values.contact.social.filter((_, i) => i !== index) })}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Button
            className="h-9"
            disabled={values.contact.social.length >= 12}
            onClick={() => updateContact({ social: [...values.contact.social, { platform: 'Instagram', url: '' }] })}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add a social link
          </Button>
        </div>
      </Section>

      {/* ───────────── Existing content ───────────── */}
      <Section
        error={fieldErrors['keep_existing_content']}
        explainer="Your site came with sample pages and posts so it was not empty on day one."
        icon={FileText}
        title="Existing content"
      >
        <RadioGroup
          aria-label="Existing content"
          className="grid gap-2 sm:grid-cols-2"
          onValueChange={(value) => update('keep_existing_content', value === 'keep')}
          value={values.keep_existing_content ? 'keep' : 'replace'}
        >
          {(
            [
              { hint: 'The sample pages, posts and menus go; your site takes their place.', label: 'Replace the sample content with my site', value: 'replace' },
              { hint: 'Nothing is removed; Cortex adds your pages beside it.', label: "Keep what's there and add to it", value: 'keep' },
            ] as const
          ).map((option) => {
            const selected = (values.keep_existing_content ? 'keep' : 'replace') === option.value;
            const id = `brief_existing_${option.value}`;
            return (
              <label
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                  selected ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'hover:border-primary/50'
                )}
                htmlFor={id}
                key={option.value}
              >
                <RadioGroupItem className="mt-0.5" id={id} value={option.value} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            );
          })}
        </RadioGroup>
      </Section>

      {/* ───────────── Anything else ───────────── */}
      <Section
        error={fieldErrors['sells_online']}
        explainer="A site you like the look of, whether you sell online, and anything the questions above missed."
        icon={MessageCircleMore}
        optional
        title="Anything else"
      >
        <Field
          error={fieldErrors['reference_url']}
          hint="Cortex looks at it for layout and mood, not to copy it."
          htmlFor="brief_reference_url"
          label="A site you like"
        >
          <Input
            id="brief_reference_url"
            inputMode="url"
            maxLength={2048}
            onChange={(event) => update('reference_url', event.target.value)}
            placeholder="https://example.com"
            type="url"
            value={values.reference_url ?? ''}
          />
        </Field>
        <div className="flex items-start gap-2">
          <Checkbox
            checked={values.sells_online}
            className="mt-0.5"
            id="brief_sells_online"
            onCheckedChange={(checked) => update('sells_online', checked === true)}
          />
          <Label className="cursor-pointer text-sm font-normal leading-snug" htmlFor="brief_sells_online">
            I sell products online
            <span className="block text-xs text-muted-foreground">
              Adds the shop, cart and checkout pages to the plan.
            </span>
          </Label>
        </div>
        <Field error={fieldErrors['notes']} htmlFor="brief_notes" label="Notes for Cortex">
          <Textarea
            id="brief_notes"
            maxLength={4000}
            onChange={(event) => update('notes', event.target.value)}
            placeholder="We close in August. Please mention the wholesale service for restaurants. No stock photos of croissants, we have our own."
            rows={3}
            value={values.notes ?? ''}
          />
        </Field>
      </Section>

      {message && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not save the brief</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        <Button className="text-muted-foreground" disabled={isPending} onClick={onSkip} type="button" variant="ghost">
          {isEditing ? 'Cancel, keep the saved brief' : 'Skip, let Cortex interview me in chat'}
        </Button>
        <Button className="w-full sm:w-auto" disabled={!canSave} type="submit">
          {isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
          {isPending ? 'Saving…' : 'Save brief & continue'}
        </Button>
      </div>
    </form>
  );
}
