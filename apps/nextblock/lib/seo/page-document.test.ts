import { describe, expect, it } from 'vitest';
import { auditSeo, emptySeoDocument, tokenizeWords } from '@nextblock-cms/utils/seo';
import { buildPageSeoDocument } from './page-document';

/**
 * The walker is the piece that decides what the page-level audit is allowed to
 * see, so these tests are written against the block shapes the CMS actually
 * stores — `{ block_type, content }` rows, with a section's children nested in
 * `content.column_blocks[column][index]` rather than sitting in the row list.
 *
 * Two things are asserted over and over on purpose. Content must be *found*,
 * because a walker that quietly misses a container under-reports the page and
 * hands the author a score for copy that was never read; and malformed content
 * must be *survived*, because this runs on every keystroke over half-typed
 * editor state where any field can be null or the wrong type.
 */

/** A rich-text block as the editor stores it when the content is HTML. */
function textBlock(html: string): unknown {
  return { block_type: 'text', content: { html_content: html } };
}

/** A standalone heading block, the shape a per-block audit could never see. */
function headingBlock(level: number, text: string): unknown {
  return { block_type: 'heading', content: { level, text_content: text } };
}

/** A section, whose children are plain objects inside its columns. */
function sectionBlock(columns: unknown[][]): unknown {
  return { block_type: 'section', content: { column_blocks: columns } };
}

describe('buildPageSeoDocument on an empty or unusable input', () => {
  it('returns an empty document rather than throwing', () => {
    const empty = emptySeoDocument();

    expect(buildPageSeoDocument([])).toEqual(empty);
    expect(buildPageSeoDocument(null)).toEqual(empty);
    expect(buildPageSeoDocument(undefined)).toEqual(empty);
    expect(buildPageSeoDocument('not blocks')).toEqual(empty);
    expect(buildPageSeoDocument({ block_type: 'text' })).toEqual(empty);
  });
});

describe('buildPageSeoDocument across sibling blocks', () => {
  const document = buildPageSeoDocument([
    headingBlock(1, 'Fresh Cat Food'),
    textBlock('<p>We ship every order fast.</p>'),
    headingBlock(2, 'Why It Works'),
  ]);

  it('merges every block into a single document with the headings in order', () => {
    expect(document.headings).toEqual([
      { level: 1, order: 0, text: 'Fresh Cat Food' },
      { level: 2, order: 1, text: 'Why It Works' },
    ]);
  });

  it('renumbers `order` sequentially across the whole page', () => {
    // Each block starts its own numbering, so the page-level order can only
    // come from the walker. It is the number the audit cites when it tells an
    // author where their H1 sits, so an off-by-one here points at the wrong
    // heading.
    const withInlineHeadings = buildPageSeoDocument([
      textBlock('<h2>Inline one</h2><h3>Inline two</h3>'),
      headingBlock(2, 'Standalone three'),
    ]);

    expect(withInlineHeadings.headings.map((heading) => heading.order)).toEqual([0, 1, 2]);
    expect(withInlineHeadings.headings[2]?.text).toBe('Standalone three');
  });

  it('keeps the text of adjacent blocks from gluing into one word', () => {
    // "…our coffee" followed by "beans are…" must not tokenise as "coffeebeans":
    // that single fabricated word would corrupt the word count, the keyphrase
    // density and the readability sample in one go.
    const glued = buildPageSeoDocument([
      textBlock('<p>We roast our coffee</p>'),
      textBlock('<p>beans are fresh</p>'),
    ]);

    expect(glued.words).toEqual(['we', 'roast', 'our', 'coffee', 'beans', 'are', 'fresh']);
    expect(glued.text).toBe('We roast our coffee beans are fresh');
  });

  it('keeps `words` in step with `text`', () => {
    // Every downstream metric reads one or the other and assumes they describe
    // the same prose: readability tokenises `text`, the density divides by
    // `words.length`.
    expect(document.words).toEqual(tokenizeWords(document.text));
  });

  it('counts heading copy as page text', () => {
    expect(document.text).toContain('Fresh Cat Food');
    expect(document.words).toContain('fresh');
  });
});

describe('buildPageSeoDocument on nested sections', () => {
  it('finds blocks nested inside a section column', () => {
    const document = buildPageSeoDocument([
      sectionBlock([[headingBlock(1, 'Nested Title'), textBlock('<p>Nested copy.</p>')]]),
    ]);

    expect(document.headings).toEqual([{ level: 1, order: 0, text: 'Nested Title' }]);
    expect(document.text).toBe('Nested Title Nested copy.');
  });

  it('reads column 0 before column 1', () => {
    const document = buildPageSeoDocument([
      sectionBlock([[headingBlock(2, 'Left')], [headingBlock(3, 'Right')]]),
    ]);

    expect(document.headings.map((heading) => heading.text)).toEqual(['Left', 'Right']);
    expect(document.text).toBe('Left Right');
  });

  it('follows a section nested inside another section', () => {
    const document = buildPageSeoDocument([
      sectionBlock([[sectionBlock([[textBlock('<p>Two levels down.</p>')]])]]),
    ]);

    expect(document.text).toBe('Two levels down.');
  });

  it('reads a slider section from its slides instead of its columns', () => {
    // A section in slider mode renders its slides and ignores whatever is left
    // in `column_blocks`, so counting both would credit the page with copy no
    // visitor can reach.
    const document = buildPageSeoDocument([
      {
        block_type: 'section',
        content: {
          column_blocks: [[textBlock('<p>Stale hidden copy.</p>')]],
          slider: true,
          slides: [{ column_blocks: [[textBlock('<p>Visible slide copy.</p>')]] }],
        },
      },
    ]);

    expect(document.text).toBe('Visible slide copy.');
  });

  it('still reads a legacy hero block, which stores its children in slides', () => {
    const document = buildPageSeoDocument([
      {
        block_type: 'hero',
        content: { slides: [{ column_blocks: [[headingBlock(1, 'Legacy Hero')]] }] },
      },
    ]);

    expect(document.headings).toEqual([{ level: 1, order: 0, text: 'Legacy Hero' }]);
  });
});

describe('buildPageSeoDocument on rich-text blocks', () => {
  it('reads an html_content that holds a JSON-stringified Tiptap document', () => {
    // Both storage formats are live in the same column; the app tells them apart
    // by a leading brace, and so must anything that reads the column.
    const tiptap = JSON.stringify({
      content: [
        { attrs: { level: 2 }, content: [{ text: 'Tiptap Heading', type: 'text' }], type: 'heading' },
        { content: [{ text: 'Tiptap paragraph copy.', type: 'text' }], type: 'paragraph' },
      ],
      type: 'doc',
    });

    const document = buildPageSeoDocument([textBlock(tiptap)]);

    expect(document.headings).toEqual([{ level: 2, order: 0, text: 'Tiptap Heading' }]);
    expect(document.text).toBe('Tiptap Heading Tiptap paragraph copy.');
  });

  it('collects images and links embedded in prose', () => {
    const document = buildPageSeoDocument([
      textBlock('<p><img src="/inline.png" alt=""><a href="https://example.com">Away</a></p>'),
    ]);

    expect(document.images).toEqual([{ alt: '', src: '/inline.png' }]);
    expect(document.links).toEqual([
      { external: true, href: 'https://example.com', text: 'Away' },
    ]);
  });
});

describe('buildPageSeoDocument on image, button and video blocks', () => {
  it('reports an image block through the same alt-text channel as inline images', () => {
    const document = buildPageSeoDocument([
      { block_type: 'image', content: { alt_text: 'A bowl of cat food', object_key: 'cat.png' } },
      { block_type: 'image', content: { alt_text: '', external_url: 'https://cdn.test/b.png' } },
    ]);

    expect(document.images).toEqual([
      { alt: 'A bowl of cat food', src: 'cat.png' },
      { alt: '', src: 'https://cdn.test/b.png' },
    ]);
  });

  it('prefers the external URL, which is what the renderer draws', () => {
    const document = buildPageSeoDocument([
      {
        block_type: 'image',
        content: { alt_text: 'Stock', external_url: 'https://cdn.test/a.png', object_key: 'a.png' },
      },
    ]);

    expect(document.images[0]?.src).toBe('https://cdn.test/a.png');
  });

  it('ignores an image block with no source at all', () => {
    // That block renders a "media not selected" placeholder, so flagging its
    // missing alt text would be a complaint about an image nobody can see.
    const document = buildPageSeoDocument([{ block_type: 'image', content: { alt_text: '' } }]);

    expect(document.images).toEqual([]);
  });

  it('includes an image caption in the page text', () => {
    const document = buildPageSeoDocument([
      {
        block_type: 'image',
        content: { alt_text: 'Beans', caption: 'Beans drying in the sun.', object_key: 'b.png' },
      },
    ]);

    expect(document.text).toBe('Beans drying in the sun.');
  });

  it('records a button as a link and its label as text', () => {
    const document = buildPageSeoDocument([
      { block_type: 'button', content: { text: 'Shop now', url: '/shop' } },
    ]);

    expect(document.links).toEqual([{ external: false, href: '/shop', text: 'Shop now' }]);
    expect(document.text).toBe('Shop now');
  });

  it('keeps a button label even when no URL has been set yet', () => {
    const document = buildPageSeoDocument([{ block_type: 'button', content: { text: 'Shop now' } }]);

    expect(document.links).toEqual([]);
    expect(document.text).toBe('Shop now');
  });

  it('takes a video block title as text when there is one', () => {
    const document = buildPageSeoDocument([
      { block_type: 'video_embed', content: { title: 'How we roast', url: 'https://v.test/1' } },
      { block_type: 'video_embed', content: { url: 'https://v.test/2' } },
    ]);

    expect(document.text).toBe('How we roast');
  });

  it('takes a testimonial quote and its attribution', () => {
    const document = buildPageSeoDocument([
      {
        block_type: 'testimonial',
        content: { author_name: 'Jane Doe', author_title: 'CEO', quote: 'It changed my morning.' },
      },
    ]);

    expect(document.text).toBe('It changed my morning. Jane Doe CEO');
  });
});

describe('buildPageSeoDocument on content it cannot read', () => {
  it('skips unknown and custom block types instead of guessing at their fields', () => {
    const document = buildPageSeoDocument([
      { block_type: 'pricing-table-v2', content: { internal_label: 'Do not index me', rows: 4 } },
      { block_type: 'posts_grid', content: { columns: 3, postsPerPage: 6 } },
      headingBlock(2, 'Real Heading'),
    ]);

    expect(document.headings).toEqual([{ level: 2, order: 0, text: 'Real Heading' }]);
    expect(document.text).toBe('Real Heading');
  });

  it('survives every field being the wrong type or absent', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      42,
      'a string where a row should be',
      [],
      { block_type: 'text' },
      { block_type: 'text', content: null },
      { block_type: 'text', content: { html_content: 12 } },
      { block_type: 'heading', content: {} },
      { block_type: 'image', content: { alt_text: null, object_key: null } },
      { block_type: 'button', content: { text: null, url: null } },
      { block_type: 'section', content: { column_blocks: 'not an array' } },
      { block_type: 'section', content: { column_blocks: [null, [null, 7]] } },
      { block_type: 'section', content: {} },
      { content: { html_content: '<p>No block type.</p>' } },
    ];

    expect(() => buildPageSeoDocument(malformed)).not.toThrow();

    const document = buildPageSeoDocument(malformed);

    // The one heading with no fields at all still surfaces, because an empty
    // heading is a real defect the audit reports rather than a row to discard.
    expect(document.headings).toEqual([{ level: 2, order: 0, text: '' }]);
    expect(document.text).toBe('');
    expect(document.words).toEqual([]);
  });

  it('stops descending once the nesting is deeper than any real page', () => {
    // Guards against a corrupt row that refers back into itself: the walk is
    // bounded, so the editor degrades to missing copy rather than to a blown
    // stack while someone is typing.
    let nested: unknown = textBlock('<p>Deepest copy.</p>');
    for (let level = 0; level < 40; level += 1) {
      nested = sectionBlock([[nested]]);
    }

    expect(() => buildPageSeoDocument([nested])).not.toThrow();
    expect(buildPageSeoDocument([nested]).text).toBe('');
  });
});

describe('buildPageSeoDocument feeding the page-level audit', () => {
  it('no longer reports a missing H1 when the H1 lives in its own block', () => {
    // This is the bug that prompted the page-level audit: the paragraph block
    // was graded on its own and reported "this page has no H1" while the H1 sat
    // one row above it, in a block the auditor was never shown.
    const blocks = [
      headingBlock(1, 'Fresh Cat Food'),
      sectionBlock([[textBlock('<p>We ship every order fast and pack it with care.</p>')]]),
    ];

    const paragraphOnly = auditSeo({ document: buildPageSeoDocument([blocks[1]]) });
    const wholePage = auditSeo({ document: buildPageSeoDocument(blocks) });

    expect(paragraphOnly.issues.map((issue) => issue.id)).toContain('headings-missing-h1');
    expect(wholePage.issues.map((issue) => issue.id)).not.toContain('headings-missing-h1');
    expect(wholePage.headings).toEqual([{ level: 1, order: 0, text: 'Fresh Cat Food' }]);
  });

  it('counts the words of the whole page rather than of one paragraph', () => {
    const sentence = '<p>We ship every order fast and we pack it with care for your pet today.</p>';
    const blocks = new Array(30).fill(null).map(() => textBlock(sentence));

    const oneBlock = auditSeo({ document: buildPageSeoDocument([blocks[0]]) });
    const wholePage = auditSeo({ document: buildPageSeoDocument(blocks) });

    expect(oneBlock.issues.map((issue) => issue.id)).toContain('content-thin');
    expect(wholePage.issues.map((issue) => issue.id)).not.toContain('content-thin');
  });

  it('treats post title as H1 when documentType is post', () => {
    const blocks = [
      headingBlock(2, 'Overview'),
      textBlock('<p>Detailed article content goes here.</p>'),
    ];

    const withoutOptions = buildPageSeoDocument(blocks);
    expect(withoutOptions.headings.map((h) => h.level)).toEqual([2]);

    const withPost = buildPageSeoDocument(blocks, {
      documentTitle: 'My Great Article',
      documentType: 'post',
    });
    expect(withPost.headings).toEqual([
      { level: 1, order: 0, text: 'My Great Article' },
      { level: 2, order: 1, text: 'Overview' },
    ]);
    expect(withPost.words).toContain('my');
    expect(withPost.words).toContain('article');

    const audit = auditSeo({ document: withPost });
    expect(audit.issues.map((i) => i.id)).not.toContain('headings-missing-h1');
  });

  it('handles empty blocks with post title', () => {
    const doc = buildPageSeoDocument([], {
      documentTitle: 'Initial Draft Post',
      documentType: 'post',
    });
    expect(doc.headings).toEqual([{ level: 1, order: 0, text: 'Initial Draft Post' }]);
    expect(doc.text).toBe('Initial Draft Post');
  });

  it('prepends product title as H1 when documentType is product', () => {
    const blocks = [
      {
        block_type: 'section',
        content: {
          column_blocks: [
            [
              {
                block_type: 'heading',
                content: { level: 2, text_content: 'Features' },
              },
            ],
          ],
        },
      },
    ];

    const withProduct = buildPageSeoDocument(blocks, {
      documentTitle: 'NextBlock Commerce Pro',
      documentType: 'product',
    });

    expect(withProduct.headings).toEqual([
      { level: 1, order: 0, text: 'NextBlock Commerce Pro' },
      { level: 2, order: 1, text: 'Features' },
    ]);
    expect(withProduct.words).toContain('commerce');
    expect(withProduct.words).toContain('pro');

    const audit = auditSeo({ document: withProduct });
    expect(audit.issues.map((i) => i.id)).not.toContain('headings-missing-h1');
  });
});


