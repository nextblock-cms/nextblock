import { generateText } from 'ai';
import { z } from './zod-config';

import {
  buildCortexAiRoutingPolicy,
  createCortexAiOpenRouterClient,
} from './ai-client';
import {
  getHttpStatusCode,
  isOpenRouterRecoverableRoutingError,
  omitUnsupportedCortexAiModelOptions,
  runWithCortexAiModelFallback,
  type CortexAiModelAttempt,
  type CortexAiOpenRouterModelId,
  type CortexAiStoredModelSelection,
} from './ai-model-registry';

export const generateEditorBlocksRequestSchema = z.strictObject({
  context: z.string().max(2000).optional(),
  prompt: z.string().min(3).max(4000),
});

export type GenerateEditorBlocksRequest = z.infer<typeof generateEditorBlocksRequestSchema>;

export type GenerateEditorHtmlFragmentResult = {
  attempts: readonly CortexAiModelAttempt[];
  credentialSource: 'env' | 'stored' | 'manual';
  html: string;
  modelId: CortexAiOpenRouterModelId;
};

const CORTEX_AI_HTML_GENERATION_ATTEMPT_TIMEOUT_MS = 60_000;

function buildInlineHtmlAssistantSystemPrompt() {
  return [
    'You are NextBlock Cortex AI, an inline rich-text assistant for a Tiptap editor.',
    'Return ONLY an HTML fragment. Do not return markdown fences, JSON, prose explanations, or commentary.',
    'Do not include <!doctype>, <html>, <head>, or <body>. The output is inserted inside an existing editor document.',
    'Use semantic HTML: headings, paragraphs, unordered and ordered lists, blockquotes, pre/code blocks, horizontal rules, and tables.',
    'Use the current editor context for continuity, but do not repeat existing copy unless the user explicitly asks for a rewrite.',
    'For tables, use valid <table>, <thead>, <tbody>, <tr>, <th>, and <td> markup with aligned rows and non-empty cells.',
    'Never use blank table spacer rows, blank spacer columns, empty cells, <colgroup>, colspan, or rowspan unless the user explicitly asks for a blank template.',
    'If CSS or JavaScript is explicitly requested, use proper <style> or <script> tags. The editor preserves those tags through its source-mode HTML parser.',
    'Keep copy production-ready, editable, and concise unless the user asks for longer content.',
  ].join(' ');
}

function buildHtmlGenerationPrompt(params: GenerateEditorBlocksRequest) {
  return [
    'Create an HTML fragment for this inline editor request:',
    params.prompt,
    /\b(table|pricing table|comparison table)\b/i.test(params.prompt)
      ? [
          'Table requirements:',
          '- Use a short header row.',
          '- Use only the real content columns requested by the user.',
          '- Do not add blank spacer columns or blank spacer rows.',
          '- Do not use <colgroup>, colspan, or rowspan.',
          '- Put normal descriptive prose before or after the table, not inside a table cell.',
          '- Body rows must match the header column count.',
          '- Every header and body cell must contain meaningful text.',
        ].join('\n')
      : null,
    params.context ? `Current editor context:\n${params.context}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function decodeBasicHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function getHtmlText(value: string) {
  return decodeBasicHtmlEntities(
    value
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function isEmptyHtml(value: string) {
  return getHtmlText(value).length === 0;
}

function stripEmptyTopLevelBlocks(html: string) {
  return html
    .replace(/<(p|h[1-6])\b[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/\1>/gi, '')
    .trim();
}

function normalizeTableHtml(tableHtml: string) {
  const rowMatches = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];

  if (rowMatches.length === 0) {
    return tableHtml;
  }

  const rows = rowMatches
    .map((rowMatch) => {
      const cells = [...rowMatch[1].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(
        (cellMatch) => ({
          innerHtml: cellMatch[2].trim(),
          tag: cellMatch[1].toLowerCase() as 'td' | 'th',
        })
      );

      return { cells };
    })
    .filter((row) => row.cells.some((cell) => !isEmptyHtml(cell.innerHtml)));

  if (rows.length === 0) {
    return tableHtml;
  }

  const maxColumnCount = Math.max(...rows.map((row) => row.cells.length));
  const emptyColumnIndexes = new Set<number>();

  for (let columnIndex = 0; columnIndex < maxColumnCount; columnIndex++) {
    const isColumnEmpty = rows.every((row) => {
      const cell = row.cells[columnIndex];
      return !cell || isEmptyHtml(cell.innerHtml);
    });

    if (isColumnEmpty) {
      emptyColumnIndexes.add(columnIndex);
    }
  }

  const normalizedRows = rows
    .map((row) => ({
      cells: row.cells.filter((cell, cellIndex) => !emptyColumnIndexes.has(cellIndex)),
    }))
    .filter((row) => row.cells.length > 0);

  if (normalizedRows.length === 0) {
    return tableHtml;
  }

  const renderRow = (row: (typeof normalizedRows)[number]) =>
    `<tr>${row.cells.map((cell) => `<${cell.tag}>${cell.innerHtml}</${cell.tag}>`).join('')}</tr>`;
  const hasHeaderRow = normalizedRows[0].cells.some((cell) => cell.tag === 'th');

  if (!hasHeaderRow) {
    return `<table><tbody>${normalizedRows.map(renderRow).join('')}</tbody></table>`;
  }

  const [headerRow, ...bodyRows] = normalizedRows;

  return `<table><thead>${renderRow(headerRow)}</thead><tbody>${bodyRows
    .map(renderRow)
    .join('')}</tbody></table>`;
}

function normalizeGeneratedTables(html: string) {
  return html.replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) =>
    normalizeTableHtml(tableHtml)
  );
}

function assertTablesHaveMeaningfulCells(html: string) {
  const tableMatches = [...html.matchAll(/<table\b[\s\S]*?<\/table>/gi)];

  for (const tableMatch of tableMatches) {
    const tableHtml = tableMatch[0];
    const rowMatches = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];

    if (rowMatches.length === 0) {
      throw new Error('Cortex AI returned a table without rows.');
    }

    const columnCounts: number[] = [];

    for (const rowMatch of rowMatches) {
      const cells = [...rowMatch[1].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)];

      if (cells.length === 0) {
        throw new Error('Cortex AI returned a table row without cells.');
      }

      for (const cellMatch of cells) {
        if (isEmptyHtml(cellMatch[2])) {
          throw new Error('Cortex AI returned a table with empty cells.');
        }
      }

      columnCounts.push(cells.length);
    }

    if (new Set(columnCounts).size > 1) {
      throw new Error('Cortex AI returned a table with uneven row widths.');
    }
  }
}

function normalizeCommonHtmlWrappers(rawText: string) {
  let html = rawText.trim();

  if (
    ((html.startsWith('"') && html.endsWith('"')) ||
      (html.startsWith("'") && html.endsWith("'"))) &&
    html.slice(1, -1).includes('<')
  ) {
    html = html.slice(1, -1).trim();
  }

  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) {
    html = bodyMatch[1].trim();
  }

  return stripEmptyTopLevelBlocks(normalizeGeneratedTables(html));
}

export function validateGeneratedEditorHtmlFragment(rawText: string) {
  const html = normalizeCommonHtmlWrappers(rawText);

  if (!html.trim()) {
    throw new Error('Cortex AI returned empty HTML.');
  }

  if (/```/.test(html)) {
    throw new Error('Cortex AI returned markdown code fences instead of an HTML fragment.');
  }

  if (/<!doctype\b|<html\b|<head\b|<body\b/i.test(html)) {
    throw new Error('Cortex AI returned a full HTML document instead of an HTML fragment.');
  }

  if (/^(sure|certainly|of course|here(?:'s| is)|below is|i can)\b/i.test(html)) {
    throw new Error('Cortex AI returned a conversational response instead of an HTML fragment.');
  }

  if (!/<[a-z][\w:-]*(?:\s[^>]*)?>/i.test(html)) {
    throw new Error('Cortex AI returned plain text instead of semantic HTML.');
  }

  assertTablesHaveMeaningfulCells(html);

  return html;
}

function isRecoverableHtmlGenerationError(error: unknown) {
  const statusCode = getHttpStatusCode(error);

  if (statusCode === 401 || statusCode === 402 || statusCode === 403) {
    return false;
  }

  if (isOpenRouterRecoverableRoutingError(error)) {
    return true;
  }

  if (statusCode && statusCode >= 500) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /NoContentGenerated|No content generated|Provider returned error|empty HTML|markdown code fences|full HTML document|conversational response|plain text|aborted|abort|timeout|timed out/i.test(
    message
  );
}

export async function generateEditorHtmlFragment(
  params: GenerateEditorBlocksRequest & {
    apiKey?: string;
    fallbackModelIds?: readonly CortexAiOpenRouterModelId[];
    modelId?: CortexAiOpenRouterModelId;
    modelSelection?: CortexAiStoredModelSelection | null;
  }
): Promise<GenerateEditorHtmlFragmentResult> {
  const { apiKey, fallbackModelIds, modelId, modelSelection, ...requestParams } = params;
  const request = generateEditorBlocksRequestSchema.parse(requestParams);
  const client = await createCortexAiOpenRouterClient({ apiKey, modelSelection });
  const routingPolicy = buildCortexAiRoutingPolicy({
    credentialSource: client.credentialSource,
    fallbackModelIds,
    requestedModelId: modelId,
    selectedModel: client.modelSelection,
  });

  const generation = await runWithCortexAiModelFallback({
    modelIds: routingPolicy.modelIds,
    shouldRetry: isRecoverableHtmlGenerationError,
    execute: async (attemptModelId) => {
      const abortController = new AbortController();
      const timeoutId = setTimeout(
        () => abortController.abort(),
        CORTEX_AI_HTML_GENERATION_ATTEMPT_TIMEOUT_MS
      );

      try {
        const attemptOptions = omitUnsupportedCortexAiModelOptions(
          {
            abortSignal: abortController.signal,
            maxOutputTokens: 5000,
            maxRetries: 0,
            prompt: buildHtmlGenerationPrompt(request),
            instructions: buildInlineHtmlAssistantSystemPrompt(),
            temperature: 0.2,
          } as Record<string, unknown>,
          {
            modelId: attemptModelId,
            modelSelection: routingPolicy.modelSelection,
          }
        );

        const result = await generateText({
          ...attemptOptions,
          model: client.model(attemptModelId),
        } as Parameters<typeof generateText>[0]);

        return validateGeneratedEditorHtmlFragment(result.text);
      } finally {
        clearTimeout(timeoutId);
      }
    },
  });

  return {
    attempts: generation.attempts,
    credentialSource: client.credentialSource,
    html: generation.result,
    modelId: generation.modelId,
  };
}

export const INLINE_HTML_ASSISTANT_SYSTEM_PROMPT =
  'Built at runtime for HTML-fragment rich-text assistance.';
