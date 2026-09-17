import React from 'react';
import parse from 'html-react-parser';
import type { CustomBlockDefinition, CustomBlockField, CustomBlockLayoutNode } from '@nextblock-cms/utils';

import { resolveMediaUrl } from '../../lib/media/resolveMediaUrl';
import { embedSafeParserOptions } from '../media/youtube-embed-replace';
import { rewriteYouTubeHostsInHtml } from '../../lib/media/youtube';

export const DYNAMIC_LAYOUT_ENGINE_CACHE_TAG = 'dynamic-layout-engine';
export const DYNAMIC_LAYOUT_ENGINE_MAX_DEPTH = 64;

const CONTAINER_ELEMENTS = new Set([
  'article',
  'aside',
  'blockquote',
  'div',
  'figure',
  'figcaption',
  'h2',
  'h3',
  'p',
  'section',
  'span',
]);

const FIELD_ELEMENTS = new Set([...CONTAINER_ELEMENTS, 'img']);
const RELATION_DISPLAY_FALLBACK_COLUMNS = [
  'title',
  'name',
  'full_name',
  'file_name',
  'slug',
  'id',
];

type DynamicLayoutData = Record<string, unknown> & {
  resolved_relations?: Record<string, unknown>;
};

type ResolvedRelationEntry = {
  error?: string;
  record?: Record<string, unknown> | null;
  table?: string;
  value?: string;
};

export type DynamicLayoutEngineProps = {
  cacheTags?: string[];
  className?: string;
  /** ISO 4217 code for bare minor-unit prices and the preferred entry of a currency map. */
  currency?: string;
  data?: DynamicLayoutData;
  definition?: Pick<CustomBlockDefinition, 'fields' | 'id' | 'layout_schema' | 'name' | 'slug'>;
  fields?: CustomBlockField[];
  layoutSchema?: CustomBlockLayoutNode;
  /** BCP 47 locale of the page, for number and currency formatting. */
  locale?: string;
  maxDepth?: number;
  /**
   * Show the red developer warnings (unknown field, missing image, broken layout). They
   * are for whoever is building the block: pass true while visual editing is on. Public
   * visitors get nothing in their place. Defaults to on outside production.
   */
  showDiagnostics?: boolean;
};

type RenderContext = {
  currency?: string;
  data: DynamicLayoutData;
  fieldsByKey: Map<string, CustomBlockField>;
  locale: string;
  maxDepth: number;
  path: string;
  showDiagnostics: boolean;
  visited: WeakSet<object>;
};

export function getDynamicLayoutDefinitionCacheTag(idOrSlug: string) {
  return `${DYNAMIC_LAYOUT_ENGINE_CACHE_TAG}:definition:${idOrSlug}`;
}

function WarningTag({ message, show }: { message: string; show: boolean }) {
  if (!show) return null;

  return (
    <span
      className="inline-flex rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive"
      data-dynamic-layout-warning=""
    >
      {message}
    </span>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLayoutNode(value: unknown): value is CustomBlockLayoutNode {
  return isRecord(value) && (value.type === 'container' || value.type === 'field_render');
}

function resolveElement(
  requested: unknown,
  fallback: keyof React.JSX.IntrinsicElements,
  allowedElements: Set<string>
) {
  return typeof requested === 'string' && allowedElements.has(requested)
    ? (requested as keyof React.JSX.IntrinsicElements)
    : fallback;
}

function stringifyDisplayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry): string => stringifyDisplayValue(entry)).filter(Boolean).join(', ');
  }

  if (isRecord(value)) {
    for (const column of RELATION_DISPLAY_FALLBACK_COLUMNS) {
      const displayValue = value[column];
      if (displayValue !== null && displayValue !== undefined && displayValue !== '') {
        return String(displayValue);
      }
    }

    return JSON.stringify(value);
  }

  return String(value);
}

// Monetary columns are stored as integer minor units (cents) in the database but
// must be shown to visitors as currency (e.g. 25000 -> $250.00).
function isPriceColumn(column: string) {
  return column === 'price' || column === 'prices' || column === 'price_adjustment' || /_price$/.test(column) || /_prices$/.test(column);
}

const DEFAULT_PRICE_CURRENCY = 'USD';

type PriceFormat = { currency?: string; locale: string };

/**
 * Minor units -> localized currency. The divisor comes from the currency itself, so JPY
 * (no decimals) is not divided by 100, and the separators and symbol position follow the
 * page locale (`250,00 $` on a French page, not `$250.00`).
 */
function formatMinorUnits(amount: number, currency: string, locale: string) {
  try {
    const formatter = new Intl.NumberFormat(locale, { currency, style: 'currency' });
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(amount / 10 ** digits);
  } catch {
    // Unknown currency code or locale: keep the number readable instead of throwing.
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

function formatRelationColumnValue(column: string, value: unknown, format: PriceFormat): string {
  if (isPriceColumn(column)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return formatMinorUnits(value, format.currency ?? DEFAULT_PRICE_CURRENCY, format.locale);
    }
    // Multi-currency maps like { "USD": 25000 } store minor units too. The key IS the
    // currency: the first amount used to be printed with a hardcoded "$" whatever it was.
    if (isRecord(value)) {
      const entries = Object.entries(value).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])
      );
      const preferred = entries.find(([code]) => code === format.currency) ?? entries[0];
      if (preferred) {
        return formatMinorUnits(preferred[1], preferred[0], format.locale);
      }
    }
  }

  return stringifyDisplayValue(value);
}

function getResolvedRelationLabel(
  field: CustomBlockField,
  data: DynamicLayoutData,
  column: string | undefined,
  format: PriceFormat
) {
  if (field.type !== 'db_relation') {
    return '';
  }

  const targetColumn = column ?? field.display_column;
  const relation = data.resolved_relations?.[field.key];
  const entries = Array.isArray(relation) ? relation : relation ? [relation] : [];
  const labels = entries
    .map((entry) => {
      if (!isRecord(entry)) {
        return '';
      }

      const relationEntry = entry as ResolvedRelationEntry;
      if (relationEntry.record) {
        const preferred = relationEntry.record[targetColumn];
        if (preferred !== null && preferred !== undefined && preferred !== '') {
          return formatRelationColumnValue(targetColumn, preferred, format);
        }

        return stringifyDisplayValue(relationEntry.record);
      }

      return relationEntry.value ?? '';
    })
    .filter(Boolean);

  return labels.join(', ');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeImageRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !UUID_RE.test(value) &&
    (value.startsWith('http') ||
      value.startsWith('/') ||
      value.includes('/') ||
      /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(value))
  );
}

// Pulls a usable image source out of a resolved relation record. Prefers the
// configured display column when it points at an asset, then falls back to the
// well-known image-bearing columns and any nested media relation object.
function extractRelationImageRef(
  record: Record<string, unknown>,
  displayColumn: string
): string | null {
  if (looksLikeImageRef(record[displayColumn])) {
    return record[displayColumn] as string;
  }

  for (const column of ['object_key', 'main_image', 'avatar_url', 'url', 'image_url', 'file_path']) {
    if (looksLikeImageRef(record[column])) {
      return record[column] as string;
    }
  }

  const nested = record.image;
  if (isRecord(nested)) {
    if (looksLikeImageRef(nested.object_key)) {
      return nested.object_key as string;
    }
    if (looksLikeImageRef(nested.url)) {
      return nested.url as string;
    }
  }

  return null;
}

/** A human name for the related row, or nothing: never an id, a slug or a JSON dump. */
function relationImageAlt(record: Record<string, unknown>): string | undefined {
  for (const column of ['alt', 'title', 'name', 'full_name']) {
    const candidate = record[column];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return undefined;
}

function getImageValue(value: unknown) {
  if (typeof value === 'string') {
    const src = resolveMediaUrl(value);
    return src ? { alt: '', src } : null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const url = typeof value.url === 'string' ? value.url : null;
  const objectKey = typeof value.object_key === 'string' ? value.object_key : null;
  // Resolve both candidates through resolveMediaUrl: full URLs pass through
  // unchanged while bare object keys (e.g. "images/commerce-square.webp") are
  // mapped to their public/bundled location instead of resolving relative to
  // the current page URL.
  const src = resolveMediaUrl(url) ?? resolveMediaUrl(objectKey);

  if (!src) {
    return null;
  }

  return {
    alt: typeof value.alt === 'string' ? value.alt : '',
    height: typeof value.height === 'number' && value.height > 0 ? value.height : undefined,
    src,
    width: typeof value.width === 'number' && value.width > 0 ? value.width : undefined,
  };
}

function renderImageField({
  className,
  field,
  node,
  showDiagnostics,
  value,
}: {
  className?: string;
  field: CustomBlockField;
  node: Extract<CustomBlockLayoutNode, { type: 'field_render' }>;
  showDiagnostics: boolean;
  value: unknown;
}) {
  const image = getImageValue(value);
  if (!image) {
    return <WarningTag show={showDiagnostics} message={`Missing image field "${field.key}"`} />;
  }

  const img = React.createElement('img', {
    alt: image.alt || field.label,
    className: resolveElement(node.as, 'img', FIELD_ELEMENTS) === 'img' ? className : undefined,
    decoding: 'async',
    height: image.height,
    loading: 'lazy',
    src: image.src,
    width: image.width,
  });

  const requestedElement = resolveElement(node.as, 'img', FIELD_ELEMENTS);
  if (requestedElement === 'img') {
    return img;
  }

  return React.createElement(requestedElement, { className }, img);
}

function renderTextField({
  className,
  field,
  node,
  value,
}: {
  className?: string;
  field: CustomBlockField;
  node: Extract<CustomBlockLayoutNode, { type: 'field_render' }>;
  value: unknown;
}) {
  const requestedElement = resolveElement(
    node.as,
    field.type === 'rich-text' ? 'div' : 'span',
    FIELD_ELEMENTS
  );
  const element = requestedElement === 'img' ? 'span' : requestedElement;

  if (field.type === 'rich-text' && typeof value === 'string') {
    // Parsed rather than injected raw so YouTube iframes become click-to-play
    // facades; the host rewrite is the fallback for anything left as raw markup.
    const richTextHtml = value || node.emptyFallback || '';
    return React.createElement(
      element,
      { className },
      parse(rewriteYouTubeHostsInHtml(richTextHtml), embedSafeParserOptions)
    );
  }

  const displayValue =
    field.type === 'db_relation' ? stringifyDisplayValue(value) : stringifyDisplayValue(value);

  return React.createElement(
    element,
    { className },
    displayValue || node.emptyFallback || ''
  );
}

function renderFieldNode(
  node: Extract<CustomBlockLayoutNode, { type: 'field_render' }>,
  context: RenderContext
) {
  if (typeof node.field_key !== 'string') {
    return <WarningTag show={context.showDiagnostics} message="Invalid custom block field reference" />;
  }

  const field = context.fieldsByKey.get(node.field_key);
  if (!field) {
    return <WarningTag show={context.showDiagnostics} message={`Unknown field "${node.field_key}"`} />;
  }

  // A field_render node bound to a db_relation may pick a specific column of the
  // resolved record (e.g. show a product's price or title), overriding the
  // field's default display_column.
  const relationColumn = typeof node.column === 'string' && node.column ? node.column : undefined;
  const value =
    field.type === 'db_relation'
      ? getResolvedRelationLabel(field, context.data, relationColumn, {
          currency: context.currency,
          locale: context.locale,
        }) || context.data[field.key]
      : context.data[field.key];
  const className = typeof node.className === 'string' ? node.className : undefined;

  // Resolve relation fields rendered as images
  if (field.type === 'db_relation' && node.as === 'img') {
    const relation = context.data.resolved_relations?.[field.key];
    const entry = Array.isArray(relation) ? relation[0] : relation;
    let imageRef: string | null = null;
    // Carried over when the related row has them (media rows do): intrinsic dimensions stop
    // the layout shifting while the image loads, and the row's own name beats the field
    // label as alternative text.
    let imageMeta: { alt?: string; height?: unknown; width?: unknown } = {};

    if (isRecord(entry) && isRecord(entry.record)) {
      imageRef = extractRelationImageRef(entry.record, relationColumn ?? field.display_column);
      imageMeta = {
        alt: relationImageAlt(entry.record),
        height: entry.record.height,
        width: entry.record.width,
      };
    } else if (looksLikeImageRef(value)) {
      imageRef = value;
    }

    return renderImageField({
      className,
      field,
      node,
      showDiagnostics: context.showDiagnostics,
      value: imageRef ? { ...imageMeta, object_key: imageRef } : null,
    });
  }

  if (field.type === 'image_r2') {
    return renderImageField({ className, field, node, showDiagnostics: context.showDiagnostics, value });
  }

  return renderTextField({ className, field, node, value });
}

function renderContainerNode(
  node: Extract<CustomBlockLayoutNode, { type: 'container' }>,
  context: RenderContext,
  depth: number
) {
  const Element = resolveElement(node.as, 'div', CONTAINER_ELEMENTS);
  const children = Array.isArray(node.children) ? node.children : [];
  const renderedChildren = children.map((child, index) => (
    <React.Fragment key={`${context.path}.${index}`}>
      {renderDynamicLayoutNode(child, {
        ...context,
        path: `${context.path}.${index}`,
      }, depth + 1)}
    </React.Fragment>
  ));

  return React.createElement(
    Element,
    { className: typeof node.className === 'string' ? node.className : undefined },
    renderedChildren
  );
}

export function renderDynamicLayoutNode(
  node: unknown,
  context: RenderContext,
  depth = 0
): React.ReactNode {
  try {
    if (depth > context.maxDepth) {
      return <WarningTag show={context.showDiagnostics} message="Custom block layout depth limit reached" />;
    }

    if (!isLayoutNode(node)) {
      return <WarningTag show={context.showDiagnostics} message="Invalid custom block layout node" />;
    }

    if (isRecord(node)) {
      if (context.visited.has(node)) {
        return <WarningTag show={context.showDiagnostics} message="Custom block layout cycle detected" />;
      }
      context.visited.add(node);
    }

    if (node.type === 'container') {
      return renderContainerNode(node, context, depth);
    }

    return renderFieldNode(node, context);
  } catch (error) {
    console.error('[DynamicLayoutEngine] Failed to render layout node:', error);
    return <WarningTag show={context.showDiagnostics} message="Invalid custom block layout" />;
  }
}

export function DynamicLayoutEngine({
  className,
  currency,
  data,
  definition,
  fields,
  layoutSchema,
  locale = 'en',
  maxDepth = DYNAMIC_LAYOUT_ENGINE_MAX_DEPTH,
  showDiagnostics = process.env.NODE_ENV !== 'production',
}: DynamicLayoutEngineProps) {
  const resolvedLayoutSchema = layoutSchema ?? definition?.layout_schema;
  const resolvedFields = fields ?? definition?.fields ?? [];

  if (!resolvedLayoutSchema) {
    return <WarningTag show={showDiagnostics} message="Missing custom block layout" />;
  }

  const fieldsByKey = new Map(resolvedFields.map((field) => [field.key, field]));
  const rendered = renderDynamicLayoutNode(resolvedLayoutSchema, {
    currency,
    data: data ?? {},
    fieldsByKey,
    locale,
    maxDepth,
    path: 'root',
    showDiagnostics,
    visited: new WeakSet<object>(),
  });

  if (!className) {
    return <>{rendered}</>;
  }

  return <div className={className}>{rendered}</div>;
}

export default DynamicLayoutEngine;
