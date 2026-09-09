import {
  buildSeoDocument,
  emptySeoDocument,
  isExternalHref,
  tokenizeWords,
} from './document';
import type {
  SeoDocument,
  SeoHeading,
  SeoHeadingLevel,
  SeoImage,
  SeoLink,
} from './types';

/**
 * Flattens a page's or product's blocks into the single `SeoDocument` the audit grades.
 *
 * The SEO engine in `@nextblock-cms/utils/seo` was written against one document
 * that represents one page, but the CMS does not store a page as one document:
 * it stores a list of block rows, each holding its own slice of content in its
 * own differently-named field, with most of a real page's copy nested two
 * levels down inside a `section` block's columns. Auditing those rows one at a
 * time is what produced the finding this module exists to retire — "this page
 * has no H1 heading" reported against a single paragraph, when the H1 was sitting
 * in a `heading` block two rows above and the auditor was never shown it.
 *
 * So this walks the whole list in document order and merges everything into one
 * document, which lets `auditSeo` answer the questions it was designed to
 * answer — is there exactly one H1, is there enough copy, where does the
 * keyphrase fall — about the page a visitor actually reads.
 *
 * Two properties are load-bearing and every change here has to preserve them:
 *
 *  - **Nothing throws.** `content` is `Json` straight out of Postgres, and the
 *    editor hands us half-typed state on every keystroke, so a field can be
 *    null, a number, an array where an object was expected, or absent. Every
 *    read below tolerates that and skips rather than reporting. An unrecognised
 *    block — a custom block, whose content shape is whatever its author defined
 *    — is skipped for the same reason: guessing at arbitrary keys would put the
 *    author's internal configuration strings into the page's word count.
 *  - **It stays linear and allocation-light.** This runs behind the analysis
 *    panel's debounce, so it is re-run every time the author pauses typing. It
 *    makes one pass over the tree, reuses the image and link objects the HTML
 *    reader already built instead of copying them, and joins the text exactly
 *    once at the end.
 */

const MAX_BLOCK_NESTING_DEPTH = 8;
const FALLBACK_HEADING_LEVEL: SeoHeadingLevel = 2;

interface PageDocumentDraft {
  headings: SeoHeading[];
  images: SeoImage[];
  links: SeoLink[];
  textParts: string[];
  words: string[];
}

function createDraft(): PageDocumentDraft {
  return { headings: [], images: [], links: [], textParts: [], words: [] };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function readHeadingLevel(value: unknown): SeoHeadingLevel {
  const level = typeof value === 'number' ? Math.trunc(value) : Number.NaN;

  return Number.isFinite(level) && level >= 1 && level <= 6
    ? (level as SeoHeadingLevel)
    : FALLBACK_HEADING_LEVEL;
}

function appendText(draft: PageDocumentDraft, text: string): void {
  if (text === '') {
    return;
  }

  draft.textParts.push(text);
  for (const word of tokenizeWords(text)) {
    draft.words.push(word);
  }
}

function appendDocument(draft: PageDocumentDraft, document: SeoDocument): void {
  for (const heading of document.headings) {
    draft.headings.push({ level: heading.level, order: draft.headings.length, text: heading.text });
  }

  for (const image of document.images) {
    draft.images.push(image);
  }

  for (const link of document.links) {
    draft.links.push(link);
  }

  if (document.text !== '') {
    draft.textParts.push(document.text);
  }

  for (const word of document.words) {
    draft.words.push(word);
  }
}

function collectHeadingBlock(content: Record<string, unknown>, draft: PageDocumentDraft): void {
  const text = readText(content['text_content']);

  draft.headings.push({
    level: readHeadingLevel(content['level']),
    order: draft.headings.length,
    text,
  });

  appendText(draft, text);
}

function collectImageBlock(content: Record<string, unknown>, draft: PageDocumentDraft): void {
  const externalUrl = readText(content['external_url']);
  const objectKey = readText(content['object_key']);
  const source = externalUrl !== '' ? externalUrl : objectKey;

  if (source === '') {
    return;
  }

  draft.images.push({ alt: readText(content['alt_text']), src: source });
  appendText(draft, readText(content['caption']));
}

function collectButtonBlock(content: Record<string, unknown>, draft: PageDocumentDraft): void {
  const text = readText(content['text']);
  const href = readText(content['url']);

  if (href !== '') {
    draft.links.push({ external: isExternalHref(href), href, text });
  }

  appendText(draft, text);
}

function collectTestimonialBlock(
  content: Record<string, unknown>,
  draft: PageDocumentDraft
): void {
  appendText(draft, readText(content['quote']));
  appendText(draft, readText(content['author_name']));
  appendText(draft, readText(content['author_title']));
}

function collectColumnBlocks(value: unknown, draft: PageDocumentDraft, depth: number): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (const column of value) {
    if (!Array.isArray(column)) {
      continue;
    }

    for (const block of column) {
      collectBlock(block, draft, depth + 1);
    }
  }
}

function collectSectionBlock(
  content: Record<string, unknown>,
  draft: PageDocumentDraft,
  depth: number
): void {
  const slides = content['slides'];

  if (content['slider'] === true && Array.isArray(slides) && slides.length > 0) {
    for (const slide of slides) {
      const record = readRecord(slide);
      if (record !== null) {
        collectColumnBlocks(record['column_blocks'], draft, depth);
      }
    }

    return;
  }

  collectColumnBlocks(content['column_blocks'], draft, depth);
}

function collectBlock(value: unknown, draft: PageDocumentDraft, depth: number): void {
  if (depth > MAX_BLOCK_NESTING_DEPTH) {
    return;
  }

  const block = readRecord(value);
  if (block === null) {
    return;
  }

  const blockType = typeof block['block_type'] === 'string' ? block['block_type'] : '';
  const content = readRecord(block['content']);
  if (content === null) {
    return;
  }

  switch (blockType) {
    case 'text': {
      const source = content['html_content'] ?? content['text_content'];
      appendDocument(draft, buildSeoDocument(source));
      return;
    }

    case 'heading':
      collectHeadingBlock(content, draft);
      return;

    case 'image':
      collectImageBlock(content, draft);
      return;

    case 'button':
      collectButtonBlock(content, draft);
      return;

    case 'testimonial':
      collectTestimonialBlock(content, draft);
      return;

    case 'video':
    case 'video_embed':
      appendText(draft, readText(content['title']));
      return;

    case 'section':
      collectSectionBlock(content, draft, depth);
      return;

    case 'hero': {
      const slides = content['slides'];
      if (Array.isArray(slides)) {
        for (const slide of slides) {
          const record = readRecord(slide);
          if (record !== null) {
            collectColumnBlocks(record['column_blocks'], draft, depth);
          }
        }
      }

      collectColumnBlocks(content['column_blocks'], draft, depth);
      return;
    }

    default:
      return;
  }
}

export interface BuildPageSeoDocumentOptions {
  /**
   * An explicit document title to treat as the page's top-level H1.
   *
   * Posts and products render their title in a template H1 wrapper rather than
   * storing it as a heading block inside the content array. Supplying `documentTitle`
   * with `documentType: 'post' | 'product'` ensures the audit sees that H1 instead
   * of falsely reporting `headings-missing-h1`.
   */
  documentTitle?: string | null;
  /**
   * The kind of document being graded. When set to 'post' or 'product' and a documentTitle is present,
   * the title is treated as the primary H1 of the document.
   */
  documentType?: 'page' | 'post' | 'product';
}

/**
 * Flattens a list of blocks into the single `SeoDocument` the audit grades.
 *
 * Safe to call on any input: an empty or null argument returns an empty document,
 * and malformed block content is skipped silently. For posts and products, passing
 * `documentType: 'post' | 'product'` and `documentTitle` will prepend the title
 * as the single H1 of the document.
 */
export function buildPageSeoDocument(
  blocks: unknown,
  options?: BuildPageSeoDocumentOptions
): SeoDocument {
  const isPostOrProductWithTitle =
    (options?.documentType === 'post' || options?.documentType === 'product') &&
    typeof options?.documentTitle === 'string' &&
    options.documentTitle.trim() !== '';

  if (!Array.isArray(blocks) || blocks.length === 0) {
    if (isPostOrProductWithTitle) {
      const titleText = options!.documentTitle!.trim();
      const titleWords = tokenizeWords(titleText);
      return {
        headings: [{ level: 1, order: 0, text: titleText }],
        images: [],
        links: [],
        text: titleText,
        words: titleWords,
      };
    }
    return emptySeoDocument();
  }

  const draft = createDraft();
  for (const block of blocks) {
    collectBlock(block, draft, 0);
  }

  if (isPostOrProductWithTitle) {
    const titleText = options!.documentTitle!.trim();
    const titleWords = tokenizeWords(titleText);
    draft.headings.unshift({
      level: 1,
      order: 0,
      text: titleText,
    });
    for (let i = 1; i < draft.headings.length; i++) {
      draft.headings[i].order = i;
    }
    draft.textParts.unshift(titleText);
    draft.words.unshift(...titleWords);
  }

  return {
    headings: draft.headings,
    images: draft.images,
    links: draft.links,
    text: draft.textParts.join(' '),
    words: draft.words,
  };
}
