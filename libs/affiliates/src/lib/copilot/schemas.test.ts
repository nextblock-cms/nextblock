import { asSchema } from 'ai';
import { describe, expect, it } from 'vitest';

import {
  RETAILER_SECTION_BLOCK_KINDS,
  RETAILER_SECTION_BLOCK_TONES,
  retailerBioToolInputSchema,
  retailerRewriteToolInputSchema,
  retailerSectionBlockInputSchema,
  retailerSectionToolInputSchema,
} from './schemas';

const BIO =
  'I am Jane, a Montreal herbalist and mother of two. I share the teas and balms I actually use every week. I earn a commission when you shop through my page.';
const META = 'Jane’s favorite herbal teas and balms, picked by a Montreal herbalist for calm evenings at home.';

function block(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'paragraph', text: 'Hello there', items: [], tone: 'none', image_query: '', product_ids: [], ...overrides };
}

function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

describe('retailerBioToolInputSchema', () => {
  it('accepts a bio and a meta description', () => {
    expect(retailerBioToolInputSchema.safeParse({ bio: BIO, meta_description: META }).success).toBe(true);
  });

  it('rejects extra keys and missing keys', () => {
    expect(retailerBioToolInputSchema.safeParse({ bio: BIO, meta_description: META, avatar: 'x' }).success).toBe(false);
    expect(retailerBioToolInputSchema.safeParse({ bio: BIO }).success).toBe(false);
    expect(retailerBioToolInputSchema.safeParse({ meta_description: META }).success).toBe(false);
  });

  it('enforces the documented lengths', () => {
    expect(retailerBioToolInputSchema.safeParse({ bio: 'x'.repeat(79), meta_description: META }).success).toBe(false);
    expect(retailerBioToolInputSchema.safeParse({ bio: 'x'.repeat(1201), meta_description: META }).success).toBe(false);
    expect(retailerBioToolInputSchema.safeParse({ bio: BIO, meta_description: 'x'.repeat(69) }).success).toBe(false);
    expect(retailerBioToolInputSchema.safeParse({ bio: BIO, meta_description: 'x'.repeat(161) }).success).toBe(false);
    expect(retailerBioToolInputSchema.safeParse({ bio: 'x'.repeat(1200), meta_description: 'x'.repeat(160) }).success).toBe(true);
  });
});

describe('retailerSectionToolInputSchema', () => {
  const valid = { section_title: 'My evening routine', blocks: [block()] };

  it('accepts a section with every block field present', () => {
    expect(retailerSectionToolInputSchema.safeParse(valid).success).toBe(true);
    for (const kind of RETAILER_SECTION_BLOCK_KINDS) {
      expect(retailerSectionBlockInputSchema.safeParse(block({ kind })).success, kind).toBe(true);
    }
    for (const tone of RETAILER_SECTION_BLOCK_TONES) {
      expect(retailerSectionBlockInputSchema.safeParse(block({ tone })).success, tone).toBe(true);
    }
  });

  it('rejects extra keys at the top level and inside a block', () => {
    expect(retailerSectionToolInputSchema.safeParse({ ...valid, page_id: 'p' }).success).toBe(false);
    expect(retailerSectionToolInputSchema.safeParse({ ...valid, blocks: [block({ html: '<b>x</b>' })] }).success).toBe(false);
    expect(retailerSectionToolInputSchema.safeParse({ ...valid, blocks: [block({ content: [] })] }).success).toBe(false);
  });

  it('rejects a missing key at the top level and every missing block key', () => {
    expect(retailerSectionToolInputSchema.safeParse({ blocks: valid.blocks }).success).toBe(false);
    expect(retailerSectionToolInputSchema.safeParse({ section_title: valid.section_title }).success).toBe(false);
    for (const key of ['kind', 'text', 'items', 'tone', 'image_query', 'product_ids']) {
      expect(retailerSectionToolInputSchema.safeParse({ ...valid, blocks: [without(block(), key)] }).success, key).toBe(false);
    }
  });

  it('rejects unknown kinds and tones, nested editor JSON and out-of-range sizes', () => {
    const cases: Array<Record<string, unknown>> = [
      block({ kind: 'html' }),
      block({ kind: 'affiliateProductGrid' }),
      block({ tone: 'warning' }),
      block({ text: 'x'.repeat(1201) }),
      block({ items: Array.from({ length: 9 }, () => 'item') }),
      block({ items: ['x'.repeat(301)] }),
      block({ image_query: 'x'.repeat(121) }),
      block({ product_ids: Array.from({ length: 9 }, () => 'id') }),
      block({ product_ids: ['x'.repeat(65)] }),
      block({ text: { type: 'doc', content: [] } }),
      block({ items: 'one, two' }),
    ];
    for (const entry of cases) {
      expect(retailerSectionToolInputSchema.safeParse({ ...valid, blocks: [entry] }).success, JSON.stringify(entry).slice(0, 80)).toBe(false);
    }
    expect(retailerSectionToolInputSchema.safeParse({ ...valid, blocks: [] }).success).toBe(false);
    expect(retailerSectionToolInputSchema.safeParse({ ...valid, blocks: Array.from({ length: 13 }, () => block()) }).success).toBe(false);
    expect(retailerSectionToolInputSchema.safeParse({ ...valid, section_title: 'x' }).success).toBe(false);
    expect(retailerSectionToolInputSchema.safeParse({ ...valid, section_title: 'x'.repeat(121) }).success).toBe(false);
  });
});

describe('retailerRewriteToolInputSchema', () => {
  it('accepts 1 to 4000 characters and nothing else', () => {
    expect(retailerRewriteToolInputSchema.safeParse({ rewritten_text: 'Better copy.' }).success).toBe(true);
    expect(retailerRewriteToolInputSchema.safeParse({ rewritten_text: '' }).success).toBe(false);
    expect(retailerRewriteToolInputSchema.safeParse({ rewritten_text: 'x'.repeat(4001) }).success).toBe(false);
    expect(retailerRewriteToolInputSchema.safeParse({ rewritten_text: 'ok', selection: 'ok' }).success).toBe(false);
    expect(retailerRewriteToolInputSchema.safeParse({}).success).toBe(false);
  });
});

type JsonSchemaNode = Record<string, unknown>;

/** Every object node of a JSON schema, depth first. */
function objectNodes(node: unknown, out: JsonSchemaNode[] = []): JsonSchemaNode[] {
  if (typeof node !== 'object' || node === null) return out;
  const record = node as JsonSchemaNode;
  if (record['type'] === 'object') out.push(record);
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) value.forEach((item) => objectNodes(item, out));
    else if (typeof value === 'object') objectNodes(value, out);
  }
  return out;
}

describe('JSON schemas sent to the model (strict mode)', () => {
  const schemas = {
    bio: retailerBioToolInputSchema,
    section: retailerSectionToolInputSchema,
    rewrite: retailerRewriteToolInputSchema,
  };

  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name}: every object is closed, every property required, no unions, every field described`, async () => {
      const json = (await asSchema(schema as never).jsonSchema) as JsonSchemaNode;
      const serialized = JSON.stringify(json);
      expect(serialized).not.toMatch(/"(anyOf|oneOf|allOf|\$ref|not)"/);

      const objects = objectNodes(json);
      expect(objects.length).toBeGreaterThan(0);
      for (const node of objects) {
        const properties = node['properties'] as Record<string, JsonSchemaNode>;
        expect(node['additionalProperties']).toBe(false);
        expect([...(node['required'] as string[])].sort()).toEqual(Object.keys(properties).sort());
        for (const [key, property] of Object.entries(properties)) {
          expect(typeof property['description'], `${name}.${key} has a description`).toBe('string');
        }
      }
    });
  }
});
