import React from 'react';

interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface TiptapNode {
  type: string;
  content?: TiptapNode[];
  text?: string;
  marks?: TiptapMark[];
  attrs?: Record<string, unknown>;
}

interface SimpleTiptapRendererProps {
  content: unknown;
  className?: string;
}

// ── Mark helpers ──────────────────────────────────────────────────
const wrapMarks = (element: React.ReactNode, marks: TiptapMark[]): React.ReactNode => {
  return marks.reduce<React.ReactNode>((wrapped, mark) => {
    switch (mark.type) {
      case 'bold':
        return <strong>{wrapped}</strong>;
      case 'italic':
        return <em>{wrapped}</em>;
      case 'underline':
      case 'u':
        return <u>{wrapped}</u>;
      case 'strike':
        return <s>{wrapped}</s>;
      case 'code':
        return (
          <code className="bg-muted px-1.5 py-0.5 rounded text-[0.875em] font-mono">
            {wrapped}
          </code>
        );
      case 'link': {
        const href = (mark.attrs?.href as string) || '#';
        const target = (mark.attrs?.target as string) || '_blank';
        return (
          <a href={href} target={target} rel="noopener noreferrer" className="underline text-primary hover:text-primary/80">
            {wrapped}
          </a>
        );
      }
      case 'highlight': {
        const color = mark.attrs?.color as string | undefined;
        const style: React.CSSProperties = color ? { backgroundColor: color } : {};
        return <mark style={style} className={color ? undefined : 'bg-yellow-200 dark:bg-yellow-800/50'}>{wrapped}</mark>;
      }
      case 'subscript':
        return <sub>{wrapped}</sub>;
      case 'superscript':
        return <sup>{wrapped}</sup>;
      case 'textStyle': {
        const css: React.CSSProperties = {};
        if (mark.attrs?.color) css.color = mark.attrs.color as string;
        if (mark.attrs?.fontSize) css.fontSize = mark.attrs.fontSize as string;
        if (mark.attrs?.fontFamily) css.fontFamily = mark.attrs.fontFamily as string;
        return Object.keys(css).length > 0 ? <span style={css}>{wrapped}</span> : <>{wrapped}</>;
      }
      default:
        return wrapped;
    }
  }, element);
};

// ── Heading via React.createElement (avoids dynamic JSX tag typing) ──
const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

const renderHeading = (
  level: number,
  children: React.ReactNode,
  key: number,
  attrs?: Record<string, unknown>
): React.ReactElement => {
  const clampedLevel = Math.max(1, Math.min(6, level));
  const tag = HEADING_TAGS[clampedLevel - 1];
  const id = attrs?.id as string | undefined;
  return React.createElement(tag, { key, className: 'font-bold my-4', id }, children);
};

// ── Colspan / rowspan / colwidth helpers ──
const buildCellProps = (attrs?: Record<string, unknown>) => {
  const props: Record<string, unknown> = {};
  const style: React.CSSProperties = {};
  const colspan = attrs?.colspan as number | undefined;
  const rowspan = attrs?.rowspan as number | undefined;
  const colwidth = attrs?.colwidth as number[] | undefined;

  if (colspan && colspan > 1) props.colSpan = colspan;
  if (rowspan && rowspan > 1) props.rowSpan = rowspan;
  if (colwidth && Array.isArray(colwidth) && colwidth[0]) {
    style.minWidth = colwidth[0];
  }
  if (Object.keys(style).length > 0) props.style = style;

  return props;
};

// ── Main recursive renderer ──────────────────────────────────────
const renderNode = (node: TiptapNode, index: number): React.ReactNode => {
  // Text nodes with optional marks
  if (node.type === 'text') {
    const base: React.ReactNode = node.text ?? '';
    return (
      <React.Fragment key={index}>
        {node.marks?.length ? wrapMarks(base, node.marks) : base}
      </React.Fragment>
    );
  }

  const children = node.content?.map((child, i) => renderNode(child, i)) ?? null;

  switch (node.type) {
    // ── Document ────────────────────────────────────────────────
    case 'doc':
      return <div key={index}>{children}</div>;

    // ── Block-level text ────────────────────────────────────────
    case 'paragraph': {
      // Skip empty / whitespace-only paragraphs (spacer artefacts from the editor)
      const isEmpty =
        !node.content?.length ||
        node.content.every(
          (child) => child.type === 'text' && (!child.text || !child.text.trim())
        );
      if (isEmpty) return null;

      const textAlign = node.attrs?.textAlign as string | undefined;
      const style: React.CSSProperties = textAlign ? { textAlign: textAlign as React.CSSProperties['textAlign'] } : {};
      return <p key={index} className="mb-4" style={Object.keys(style).length ? style : undefined}>{children}</p>;
    }
    case 'heading':
      return renderHeading(
        (node.attrs?.level as number) || 1,
        children,
        index,
        node.attrs ?? undefined
      );

    // ── Lists ───────────────────────────────────────────────────
    case 'bulletList':
      return <ul key={index} className="list-disc pl-5 mb-4">{children}</ul>;
    case 'orderedList': {
      const start = (node.attrs?.start as number) ?? 1;
      return <ol key={index} className="list-decimal pl-5 mb-4" start={start !== 1 ? start : undefined}>{children}</ol>;
    }
    case 'listItem':
      return <li key={index}>{children}</li>;
    case 'taskList':
      return <ul key={index} className="list-none pl-0 mb-4 space-y-1">{children}</ul>;
    case 'taskItem': {
      const checked = Boolean(node.attrs?.checked);
      return (
        <li key={index} className="flex items-start gap-2">
          <input type="checkbox" checked={checked} readOnly className="mt-1.5 rounded" />
          <div className={checked ? 'line-through text-muted-foreground' : ''}>{children}</div>
        </li>
      );
    }

    // ── Quotes & code ───────────────────────────────────────────
    case 'blockquote':
      return <blockquote key={index} className="border-l-4 border-border pl-4 italic my-4">{children}</blockquote>;
    case 'codeBlock': {
      const language = node.attrs?.language as string | undefined;
      return (
        <pre key={index} className="bg-muted rounded-lg p-4 mb-4 overflow-x-auto" data-language={language || undefined}>
          <code className="text-sm font-mono">{children}</code>
        </pre>
      );
    }

    // ── Inline / void ───────────────────────────────────────────
    case 'horizontalRule':
      return <hr key={index} className="my-6 border-border" />;
    case 'hardBreak':
      return <br key={index} />;
    case 'image': {
      const src = node.attrs?.src as string;
      const alt = (node.attrs?.alt as string) || '';
      const title = node.attrs?.title as string | undefined;
      const width = node.attrs?.width as string | number | undefined;
      const height = node.attrs?.height as string | number | undefined;
      const style: React.CSSProperties = {};
      if (width) style.width = typeof width === 'number' ? `${width}px` : width;
      if (height) style.height = typeof height === 'number' ? `${height}px` : height;
      return (
        <img
          key={index}
          src={src}
          alt={alt ?? ''}
          title={title}
          // Numeric sizes also go on the element: the attributes (not the inline style) are
          // what lets the browser reserve the box before the file arrives.
          width={typeof width === 'number' ? width : undefined}
          height={typeof height === 'number' ? height : undefined}
          loading="lazy"
          decoding="async"
          style={Object.keys(style).length ? style : undefined}
          className="max-w-full h-auto rounded my-4"
        />
      );
    }

    // ── Table ───────────────────────────────────────────────────
    case 'table':
      return (
        <div key={index} className="overflow-x-auto my-4">
          <table className="w-full border-collapse border border-gray-300 dark:border-gray-700" style={{ minWidth: 500 }}>
            <tbody>{children}</tbody>
          </table>
        </div>
      );
    case 'tableRow':
      return <tr key={index} className="border-b border-gray-300 dark:border-gray-700">{children}</tr>;
    case 'tableHeader':
      return (
        <th
          key={index}
          {...buildCellProps(node.attrs ?? undefined)}
          className="bg-gray-100 dark:bg-gray-800 font-bold p-3 text-left border border-gray-300 dark:border-gray-700"
        >
          {children}
        </th>
      );
    case 'tableCell':
      return (
        <td
          key={index}
          {...buildCellProps(node.attrs ?? undefined)}
          className="p-3 border border-gray-300 dark:border-gray-700"
        >
          {children}
        </td>
      );

    // ── Details / collapsible ───────────────────────────────────
    case 'details':
      return <details key={index} className="my-4 border rounded-lg overflow-hidden">{children}</details>;
    case 'detailsSummary':
      return <summary key={index} className="cursor-pointer p-3 font-semibold bg-muted/30 hover:bg-muted/50">{children}</summary>;
    case 'detailsContent':
      return <div key={index} className="p-3 border-t">{children}</div>;

    // ── Embeds ──────────────────────────────────────────────────
    case 'youtube': {
      const src = toNoCookieEmbedSrc(node.attrs?.src as string);
      const width = (node.attrs?.width as number) || 640;
      const height = (node.attrs?.height as number) || 480;
      return (
        <div key={index} className="relative my-4 overflow-hidden rounded-lg" style={{ aspectRatio: `${width}/${height}`, maxWidth: width }}>
          <iframe
            src={src}
            title={(node.attrs?.title as string) || 'Embedded video'}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            loading="lazy"
            className="absolute inset-0 w-full h-full"
          />
        </div>
      );
    }
    case 'iframe': {
      const src = toNoCookieEmbedSrc(node.attrs?.src as string);
      return (
        <div key={index} className="my-4 overflow-hidden rounded-lg" style={{ aspectRatio: '16/9' }}>
          <iframe
            src={src}
            title={(node.attrs?.title as string) || 'Embedded content'}
            allowFullScreen
            loading="lazy"
            className="w-full h-full border-0"
          />
        </div>
      );
    }

    // ── Mention ─────────────────────────────────────────────────
    case 'mention': {
      const label = (node.attrs?.label as string) || (node.attrs?.id as string) || '';
      return <span key={index} className="text-primary font-medium">@{label}</span>;
    }

    // ── Fallback ────────────────────────────────────────────────
    default:
      // Render unknown nodes as a neutral wrapper so content is never lost
      return <div key={index}>{children}</div>;
  }
};

/**
 * Rewrite YouTube embed hosts to the privacy-enhanced domain.
 *
 * libs/* cannot import apps/nextblock (enforce-module-boundaries), so this is a
 * local copy of rewriteYouTubeHostsInHtml from apps/nextblock/lib/media/youtube.ts.
 * The app renders these surfaces through a click-to-play facade; this is the
 * fallback for standalone consumers of the published lib.
 */
export const toNoCookieEmbedSrc = (src: string | undefined): string | undefined =>
  src?.replace(
    /(?:https?:)?\/\/(?:www\.|m\.|music\.)?youtube\.com\/embed\//gi,
    'https://www.youtube-nocookie.com/embed/'
  );

// ── Public component ────────────────────────────────────────────
export const SimpleTiptapRenderer: React.FC<SimpleTiptapRendererProps> = ({ content, className }) => {
  if (!content) return null;

  // 1. Handle HTML string or stringified JSON
  if (typeof content === 'string') {
    // Check if it's stringified JSON (common in some DB drivers for jsonb)
    if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(content);
        return <SimpleTiptapRenderer content={parsed} className={className} />;
      } catch {
        // Not valid JSON, treat as HTML
      }
    }
    // Render as pure HTML
    return (
      <div
        className={className}
        dangerouslySetInnerHTML={{ __html: toNoCookieEmbedSrc(content) ?? content }}
      />
    );
  }

  // 2. Handle TipTap JSON structure
  const doc = content as TiptapNode;
  if (!doc.content || !Array.isArray(doc.content)) return null;

  return (
    <div className={className}>
      {doc.content.map((node: TiptapNode, i: number) => renderNode(node, i))}
    </div>
  );
};
