/**
 * Renders a storefront document as plain React elements. A pure function component: no hooks,
 * no client directive, no raw-HTML injection prop, no `style` attribute, literal Tailwind
 * classes only, so it is safe in React Server Components and in client trees alike. (The source
 * guard in renderer.test.tsx fails the build of any of these.)
 *
 * The first image gets `fetchPriority="high"`; React's server renderer then also emits a
 * `<link rel="preload" as="image">` hint for it (hoisted into `<head>` under RSC), with the same
 * validated src.
 *
 * Callers pass a sanitized document (`sanitizeStorefrontDoc`), but the renderer does not rely on
 * it: it reads every node defensively, renders only the allowlisted node and mark types, and checks
 * every href and image src again with the URL helpers (defense in depth). Text is rendered as React
 * text, never as markup.
 */
import { Fragment } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { AFFILIATE_HANDLE_PATTERN } from '../core/handle';
import { STOREFRONT_LIMITS } from './limits';
import { isStorefrontProductId, sanitizeStorefrontImageCredit } from './sanitize';
import { cleanStorefrontText, hasStorefrontVisibleText, truncateStorefrontText } from './text';
import type {
  StorefrontBlockDiffStatus,
  StorefrontCalloutTone,
  StorefrontImageCredit,
  StorefrontProductGridColumns,
  StorefrontRendererProps,
} from './types';
import {
  STOREFRONT_DEFAULT_LINK_REL,
  isExternalStorefrontHref,
  normalizeStorefrontImageOrigins,
  normalizeStorefrontImageSrcWithOrigins,
  normalizeStorefrontSiteOrigin,
  sanitizeStorefrontHref,
} from './urls';

type JsonRecord = Record<string, unknown>;

const ROOT_CLASS = 'break-words text-base leading-relaxed text-foreground';
const PARAGRAPH_CLASS = 'my-4 leading-relaxed';
const NESTED_PARAGRAPH_CLASS = 'leading-relaxed';
const QUOTE_PARAGRAPH_CLASS = 'my-2 leading-relaxed';
const CALLOUT_PARAGRAPH_CLASS = 'leading-relaxed';
const H2_CLASS = 'text-2xl md:text-3xl font-bold tracking-tight mt-10 mb-4';
const H3_CLASS = 'text-xl md:text-2xl font-semibold mt-8 mb-3';
const BULLET_LIST_CLASS = 'my-4 list-disc pl-6 space-y-1';
const ORDERED_LIST_CLASS = 'my-4 list-decimal pl-6 space-y-1';
const NESTED_BULLET_LIST_CLASS = 'mt-1 list-disc pl-6 space-y-1';
const NESTED_ORDERED_LIST_CLASS = 'mt-1 list-decimal pl-6 space-y-1';
const BLOCKQUOTE_CLASS = 'my-6 border-l-4 border-border pl-4 italic text-muted-foreground';
const RULE_CLASS = 'my-10 border-border';
const FIGURE_CLASS = 'my-8';
const IMAGE_CLASS = 'mx-auto h-auto max-w-full rounded-lg';
const CAPTION_CLASS = 'mt-2 text-center text-xs text-muted-foreground';
const LINK_CLASS = 'font-medium text-primary underline underline-offset-4 hover:opacity-80';
const CREDIT_LINK_CLASS = 'underline underline-offset-2 hover:opacity-80';
const GRID_CLASS = 'my-8';

const CALLOUT_CLASSES: Readonly<Record<StorefrontCalloutTone, string>> = {
  info: 'my-6 rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-foreground',
  tip: 'my-6 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-foreground',
  highlight: 'my-6 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-foreground',
};

const DIFF_CLASSES: Readonly<Record<StorefrontBlockDiffStatus, string>> = {
  unchanged: 'border-l-4 border-transparent pl-4',
  added: 'border-l-4 border-emerald-500 pl-4',
  changed: 'border-l-4 border-amber-500 pl-4',
};

const PROVIDER_NAMES: Readonly<Record<StorefrontImageCredit['provider'], string>> = {
  pexels: 'Pexels',
  unsplash: 'Unsplash',
};

/** Private-use marker that brackets the credit placeholders (never present in label copy). */
const TOKEN_MARK = String.fromCharCode(0xe000);
const PHOTOGRAPHER_TOKEN = `${TOKEN_MARK}storefront-photographer${TOKEN_MARK}`;
const PROVIDER_TOKEN = `${TOKEN_MARK}storefront-provider${TOKEN_MARK}`;
const MAX_RENDER_NODES = 20000;
const MAX_LIST_NESTING = 4;

function defaultPhotoCredit(photographer: string, provider: string): string {
  return `Photo: ${photographer} / ${provider}`;
}

interface RenderState {
  readonly origins: ReadonlySet<string>;
  readonly siteOrigin: string | null;
  readonly linkRel: string;
  readonly externalLinkRel: string;
  readonly photoCredit: (photographer: string, provider: string) => string;
  readonly renderProductGrid: StorefrontRendererProps['renderProductGrid'];
  readonly referralHandle: string | null;
  renderedImages: number;
  gridIndex: number;
  budget: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(record: JsonRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function children(node: JsonRecord): readonly unknown[] {
  const content = own(node, 'content');
  return Array.isArray(content) ? content : [];
}

function attrsOf(node: JsonRecord): JsonRecord {
  const attrs = own(node, 'attrs');
  return isRecord(attrs) ? attrs : {};
}

function spend(state: RenderState): boolean {
  state.budget -= 1;
  return state.budget >= 0;
}

/** Adds `noopener` (and `noreferrer`) to a caller-supplied rel used with `target="_blank"`. */
function withOpenerProtection(rel: string): string {
  const tokens = rel.split(/\s+/).filter((token) => token !== '');
  const lower = tokens.map((token) => token.toLowerCase());
  if (!lower.includes('noopener')) tokens.push('noopener');
  if (!lower.includes('noreferrer')) tokens.push('noreferrer');
  return tokens.join(' ');
}

function createState(props: StorefrontRendererProps): RenderState {
  const rel =
    typeof props.linkRel === 'string' && props.linkRel.trim() !== ''
      ? props.linkRel.trim()
      : STOREFRONT_DEFAULT_LINK_REL;
  const photoCredit = props.labels?.photoCredit;
  return {
    origins: normalizeStorefrontImageOrigins(props.allowedImageOrigins),
    siteOrigin: normalizeStorefrontSiteOrigin(props.siteOrigin),
    linkRel: rel,
    externalLinkRel: withOpenerProtection(rel),
    photoCredit: typeof photoCredit === 'function' ? photoCredit : defaultPhotoCredit,
    renderProductGrid: typeof props.renderProductGrid === 'function' ? props.renderProductGrid : undefined,
    referralHandle:
      typeof props.referralHandle === 'string' && AFFILIATE_HANDLE_PATTERN.test(props.referralHandle)
        ? props.referralHandle
        : null,
    renderedImages: 0,
    gridIndex: 0,
    budget: MAX_RENDER_NODES,
  };
}

// ---------------------------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------------------------

interface TextFormat {
  href: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
}

function readFormat(node: JsonRecord): TextFormat {
  const format: TextFormat = { href: null, bold: false, italic: false, underline: false, strike: false };
  const marks = own(node, 'marks');
  if (!Array.isArray(marks)) return format;
  for (const mark of marks.slice(0, 16)) {
    if (!isRecord(mark)) continue;
    const type = own(mark, 'type');
    if (type === 'bold') format.bold = true;
    else if (type === 'italic') format.italic = true;
    else if (type === 'underline') format.underline = true;
    else if (type === 'strike') format.strike = true;
    else if (type === 'link' && format.href === null) {
      format.href = sanitizeStorefrontHref(own(attrsOf(mark), 'href'));
    }
  }
  return format;
}

function textWithBreaks(text: string, key: string): ReactNode {
  if (!text.includes('\n')) return text;
  const parts: ReactNode[] = [];
  text.split('\n').forEach((line, index) => {
    if (index > 0) parts.push(<br key={`${key}-br${index}`} />);
    if (line !== '') parts.push(line);
  });
  return parts;
}

function formattedText(text: string, format: TextFormat, key: string): ReactNode {
  let node: ReactNode = textWithBreaks(text, key);
  if (format.strike) node = <s>{node}</s>;
  if (format.underline) node = <u>{node}</u>;
  if (format.italic) node = <em>{node}</em>;
  if (format.bold) node = <strong>{node}</strong>;
  return <Fragment key={key}>{node}</Fragment>;
}

/**
 * A site-internal link with `ref=<handle>` added (site-relative paths and absolute URLs on the
 * site's origin; never `mailto:` or fragment-only links), or the href unchanged when there is no
 * handle or the link already names a ref.
 */
function withReferral(href: string, state: RenderState): string {
  const handle = state.referralHandle;
  if (!handle || !(href.startsWith('/') || /^https?:\/\//i.test(href))) return href;
  try {
    const url = new URL(href, state.siteOrigin ?? 'https://storefront.invalid');
    if (url.searchParams.has('ref')) return href;
    url.searchParams.set('ref', handle);
    return href.startsWith('/') ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch {
    return href;
  }
}

function renderLink(href: string, content: ReactNode[], state: RenderState, key: string): ReactNode {
  if (!isExternalStorefrontHref(href, state.siteOrigin)) {
    return (
      <a key={key} href={withReferral(href, state)} rel={state.linkRel} className={LINK_CLASS}>
        {content}
      </a>
    );
  }
  return (
    // externalLinkRel is withOpenerProtection(linkRel), so it always holds noopener and noreferrer
    // (renderer.test.tsx asserts it for the default and a custom rel); the rule cannot read a
    // computed rel, and the rel stays configurable (SPEC: linkRel prop).
    // eslint-disable-next-line react/jsx-no-target-blank
    <a key={key} href={href} rel={state.externalLinkRel} target="_blank" className={LINK_CLASS}>
      {content}
    </a>
  );
}

function renderInline(nodes: readonly unknown[], state: RenderState, keyPrefix: string): ReactNode[] {
  const output: ReactNode[] = [];
  const items: Array<{ text: string; format: TextFormat } | 'break' | null> = nodes.map((node) => {
    if (!isRecord(node)) return null;
    const type = own(node, 'type');
    if (type === 'hardBreak') return 'break';
    if (type !== 'text') return null;
    const text = own(node, 'text');
    return typeof text === 'string' && text !== '' ? { text, format: readFormat(node) } : null;
  });
  let index = 0;
  while (index < items.length) {
    const item = items[index];
    const key = `${keyPrefix}-${index}`;
    if (item === null || item === undefined || !spend(state)) {
      index += 1;
      continue;
    }
    if (item === 'break') {
      output.push(<br key={key} />);
      index += 1;
      continue;
    }
    const href = item.format.href;
    if (href === null) {
      output.push(formattedText(item.text, item.format, key));
      index += 1;
      continue;
    }
    // Consecutive text runs that share one link render as a single anchor.
    const linked: ReactNode[] = [];
    let end = index;
    while (end < items.length) {
      const next = items[end];
      if (next === null || next === undefined || next === 'break' || next.format.href !== href) break;
      linked.push(formattedText(next.text, next.format, `${keyPrefix}-${end}`));
      end += 1;
    }
    output.push(renderLink(href, linked, state, key));
    index = end;
  }
  return output;
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

function renderParagraph(node: JsonRecord, state: RenderState, key: string, className: string): ReactElement {
  const content = renderInline(children(node), state, key);
  return (
    <p key={key} className={className}>
      {content.length > 0 ? content : <br />}
    </p>
  );
}

function listStart(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9999 ? value : 1;
}

function renderList(node: JsonRecord, state: RenderState, key: string, nesting: number): ReactElement | null {
  if (nesting > MAX_LIST_NESTING) return null;
  const ordered = own(node, 'type') === 'orderedList';
  const items: ReactNode[] = [];
  children(node).forEach((item, index) => {
    if (!isRecord(item) || own(item, 'type') !== 'listItem' || !spend(state)) return;
    const itemKey = `${key}-${index}`;
    const parts: ReactNode[] = [];
    children(item).forEach((child, childIndex) => {
      if (!isRecord(child) || !spend(state)) return;
      const type = own(child, 'type');
      const childKey = `${itemKey}-${childIndex}`;
      if (type === 'paragraph') parts.push(renderParagraph(child, state, childKey, NESTED_PARAGRAPH_CLASS));
      else if (type === 'bulletList' || type === 'orderedList') {
        const nested = renderList(child, state, childKey, nesting + 1);
        if (nested) parts.push(nested);
      }
    });
    items.push(<li key={itemKey}>{parts}</li>);
  });
  if (items.length === 0) return null;
  if (ordered) {
    const start = listStart(own(attrsOf(node), 'start'));
    return (
      <ol
        key={key}
        className={nesting > 1 ? NESTED_ORDERED_LIST_CLASS : ORDERED_LIST_CLASS}
        start={start !== 1 ? start : undefined}
      >
        {items}
      </ol>
    );
  }
  return (
    <ul key={key} className={nesting > 1 ? NESTED_BULLET_LIST_CLASS : BULLET_LIST_CLASS}>
      {items}
    </ul>
  );
}

function renderBlockquote(node: JsonRecord, state: RenderState, key: string): ReactElement | null {
  const paragraphs: ReactNode[] = [];
  children(node).forEach((child, index) => {
    if (isRecord(child) && own(child, 'type') === 'paragraph' && spend(state)) {
      paragraphs.push(renderParagraph(child, state, `${key}-${index}`, QUOTE_PARAGRAPH_CLASS));
    }
  });
  if (paragraphs.length === 0) return null;
  return (
    <blockquote key={key} className={BLOCKQUOTE_CLASS}>
      {paragraphs}
    </blockquote>
  );
}

function renderCallout(node: JsonRecord, state: RenderState, key: string): ReactElement | null {
  // A callout of spaces, zero-width characters or line breaks shows an empty box: skip it.
  if (!hasStorefrontVisibleText(children(node))) return null;
  const content = renderInline(children(node), state, key);
  if (content.length === 0) return null;
  const tone = own(attrsOf(node), 'tone');
  const className = tone === 'tip' || tone === 'highlight' ? CALLOUT_CLASSES[tone] : CALLOUT_CLASSES.info;
  return (
    <aside key={key} role="note" className={className}>
      <p className={CALLOUT_PARAGRAPH_CLASS}>{content}</p>
    </aside>
  );
}

function imageDimension(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= STOREFRONT_LIMITS.maxImageDimension
    ? value
    : undefined;
}

/** A single-line attribute text, cleaned like the sanitizer cleans it, at most `max` long. */
function plainAttribute(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const window = value.length > max * 4 ? value.slice(0, max * 4) : value;
  return truncateStorefrontText(cleanStorefrontText(window, { singleLine: true }).text.trim(), max).trimEnd();
}

function creditHref(url: string, credit: StorefrontImageCredit): string {
  if (credit.provider !== 'unsplash' || !credit.utmSource) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('utm_source', credit.utmSource);
    parsed.searchParams.set('utm_medium', 'referral');
    return parsed.href;
  } catch {
    return url;
  }
}

function callLabel(state: RenderState, photographer: string, provider: string): string {
  try {
    const label: unknown = state.photoCredit(photographer, provider);
    return typeof label === 'string' ? label : defaultPhotoCredit(photographer, provider);
  } catch {
    return defaultPhotoCredit(photographer, provider);
  }
}

type CreditSegment = 'photographer' | 'provider' | { text: string };

function withoutTokenMark(value: string): string {
  return value.split(TOKEN_MARK).join('');
}

/** Splits a label rendered with the two placeholder tokens; null unless each appears exactly once. */
function splitCreditTemplate(template: string): CreditSegment[] | null {
  if (template.split(PHOTOGRAPHER_TOKEN).length !== 2 || template.split(PROVIDER_TOKEN).length !== 2) return null;
  const segments: CreditSegment[] = [];
  let rest = template;
  while (rest !== '') {
    const photographerAt = rest.indexOf(PHOTOGRAPHER_TOKEN);
    const providerAt = rest.indexOf(PROVIDER_TOKEN);
    const nextAt = photographerAt < 0 ? providerAt : providerAt < 0 ? photographerAt : Math.min(photographerAt, providerAt);
    if (nextAt < 0) {
      segments.push({ text: withoutTokenMark(rest) });
      break;
    }
    if (nextAt > 0) segments.push({ text: withoutTokenMark(rest.slice(0, nextAt)) });
    const isPhotographer = nextAt === photographerAt;
    segments.push(isPhotographer ? 'photographer' : 'provider');
    rest = rest.slice(nextAt + (isPhotographer ? PHOTOGRAPHER_TOKEN.length : PROVIDER_TOKEN.length));
  }
  return segments;
}

/**
 * The credit line, with the photographer and provider names linked (the Unsplash attribution
 * rule). The localized label is called once with placeholder tokens to find where the two names
 * go; a label that does not place each token exactly once is shown as plain text instead.
 */
function renderCredit(credit: StorefrontImageCredit, state: RenderState, key: string): ReactNode {
  const providerName = PROVIDER_NAMES[credit.provider];
  const segments = splitCreditTemplate(callLabel(state, PHOTOGRAPHER_TOKEN, PROVIDER_TOKEN));
  if (segments === null) return withoutTokenMark(callLabel(state, credit.photographer, providerName));
  // Credit links point at the stock provider's own site; they carry no partner endorsement.
  return segments.map((segment, index) => {
    const segmentKey = `${key}-credit-${index}`;
    if (segment === 'photographer') {
      return (
        <a
          key={segmentKey}
          href={creditHref(credit.photographerUrl, credit)}
          rel="nofollow noopener noreferrer"
          target="_blank"
          className={CREDIT_LINK_CLASS}
        >
          {credit.photographer}
        </a>
      );
    }
    if (segment === 'provider') {
      return (
        <a
          key={segmentKey}
          href={creditHref(credit.sourceUrl, credit)}
          rel="nofollow noopener noreferrer"
          target="_blank"
          className={CREDIT_LINK_CLASS}
        >
          {providerName}
        </a>
      );
    }
    return segment.text;
  });
}

function renderImage(node: JsonRecord, state: RenderState, key: string): ReactElement | null {
  const attrs = attrsOf(node);
  const src = normalizeStorefrontImageSrcWithOrigins(own(attrs, 'src'), state.origins);
  if (src === null) return null;
  // The first image is the likely LCP element: load it eagerly at high priority, the rest lazily.
  const eager = state.renderedImages === 0;
  state.renderedImages += 1;
  const title = plainAttribute(own(attrs, 'title'), STOREFRONT_LIMITS.maxImageTitleLength);
  const credit = sanitizeStorefrontImageCredit(own(attrs, 'credit'));
  return (
    <figure key={key} className={FIGURE_CLASS}>
      <img
        src={src}
        alt={plainAttribute(own(attrs, 'alt'), STOREFRONT_LIMITS.maxAltLength)}
        title={title !== '' ? title : undefined}
        width={imageDimension(own(attrs, 'width'))}
        height={imageDimension(own(attrs, 'height'))}
        loading={eager ? 'eager' : 'lazy'}
        fetchPriority={eager ? 'high' : undefined}
        decoding="async"
        className={IMAGE_CLASS}
      />
      {credit ? <figcaption className={CAPTION_CLASS}>{renderCredit(credit, state, key)}</figcaption> : null}
    </figure>
  );
}

function gridColumns(value: unknown): StorefrontProductGridColumns {
  return value === 2 || value === 4 ? value : 3;
}

function renderProductGrid(node: JsonRecord, state: RenderState, key: string): ReactElement | null {
  const index = state.gridIndex;
  state.gridIndex += 1;
  if (!state.renderProductGrid) return null;
  const attrs = attrsOf(node);
  const rawIds = own(attrs, 'productIds');
  const productIds: string[] = [];
  if (Array.isArray(rawIds)) {
    for (const entry of rawIds.slice(0, STOREFRONT_LIMITS.maxProductsPerGrid * 4)) {
      if (!isStorefrontProductId(entry)) continue;
      const id = entry.toLowerCase();
      if (!productIds.includes(id)) productIds.push(id);
      if (productIds.length >= STOREFRONT_LIMITS.maxProductsPerGrid) break;
    }
  }
  const title = plainAttribute(own(attrs, 'title'), STOREFRONT_LIMITS.maxGridTitleLength);
  const rendered = state.renderProductGrid({
    productIds,
    title: title !== '' ? title : null,
    columns: gridColumns(own(attrs, 'columns')),
    index,
  });
  if (rendered === null || rendered === undefined || rendered === false) return null;
  return (
    <div key={key} className={GRID_CLASS}>
      {rendered}
    </div>
  );
}

function renderBlock(node: unknown, state: RenderState, key: string): ReactElement | null {
  if (!isRecord(node) || !spend(state)) return null;
  switch (own(node, 'type')) {
    case 'paragraph':
      return renderParagraph(node, state, key, PARAGRAPH_CLASS);
    case 'heading': {
      // An empty-looking heading (spaces, zero-width characters, line breaks) fails accessibility
      // audits and holes the outline: skip it, as the page's outline normalizer does.
      if (!hasStorefrontVisibleText(children(node))) return null;
      const content = renderInline(children(node), state, key);
      if (content.length === 0) return null;
      return own(attrsOf(node), 'level') === 3 ? (
        <h3 key={key} className={H3_CLASS}>
          {content}
        </h3>
      ) : (
        <h2 key={key} className={H2_CLASS}>
          {content}
        </h2>
      );
    }
    case 'bulletList':
    case 'orderedList':
      return renderList(node, state, key, 1);
    case 'blockquote':
      return renderBlockquote(node, state, key);
    case 'horizontalRule':
      return <hr key={key} className={RULE_CLASS} />;
    case 'image':
      return renderImage(node, state, key);
    case 'storefrontCallout':
      return renderCallout(node, state, key);
    case 'affiliateProductGrid':
      return renderProductGrid(node, state, key);
    default:
      return null;
  }
}

function diffStatus(value: unknown): StorefrontBlockDiffStatus {
  return value === 'added' || value === 'changed' ? value : 'unchanged';
}

/**
 * Renders a storefront document. Links get `rel` = `linkRel` (default
 * `nofollow ugc noopener noreferrer`) and open in a new tab only when they are absolute http(s)
 * URLs to another origin than `siteOrigin`. The first image loads eagerly with
 * `fetchPriority="high"`, later ones lazily. Product grids render through `renderProductGrid`
 * (nothing when it is omitted). `highlight` wraps each top-level block in a `data-diff` box with
 * a coloured left border (review screen).
 */
export function StorefrontRenderer(props: StorefrontRendererProps): ReactElement {
  const state = createState(props);
  const highlight = Array.isArray(props.highlight) ? props.highlight : null;
  const blocks = isRecord(props.doc) ? children(props.doc) : [];
  const rendered: ReactNode[] = [];
  const count = Math.min(blocks.length, STOREFRONT_LIMITS.maxBlocks);
  for (let index = 0; index < count; index += 1) {
    const key = `b${index}`;
    const block = renderBlock(blocks[index], state, key);
    if (block === null) continue;
    if (highlight) {
      const status = diffStatus(highlight[index]);
      rendered.push(
        <div key={key} data-diff={status} className={DIFF_CLASSES[status]}>
          {block}
        </div>,
      );
    } else {
      rendered.push(block);
    }
  }
  const className =
    typeof props.className === 'string' && props.className.trim() !== ''
      ? `${ROOT_CLASS} ${props.className.trim()}`
      : ROOT_CLASS;
  return <div className={className}>{rendered}</div>;
}
