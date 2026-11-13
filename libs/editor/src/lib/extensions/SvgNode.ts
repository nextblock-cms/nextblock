import { Node, mergeAttributes } from '@tiptap/core';
import { sanitizeAuthoredBlockHtml } from '@nextblock-cms/utils';

/**
 * The `html` attribute is the raw inner markup of an authored `<svg>` (block HTML is written by
 * any WRITER, PostgREST included), and both renderers below assign it with `innerHTML` inside the
 * live CMS editor. A `<foreignObject>` there holds ordinary HTML, so `<meta http-equiv=refresh>`
 * redirected whoever opened the block, with no script at all. Sanitized like every other render
 * of block HTML; paths, shapes and styles are untouched.
 */
const safeSvgInnerHtml = (html: unknown): string => sanitizeAuthoredBlockHtml(String(html ?? ''));

export interface SvgNodeOptions {
  HTMLAttributes: Record<string, any>;
}

export const SvgNode = Node.create<SvgNodeOptions>({
  name: 'svg',
  
  group: 'inline', // Inline to flow with text
  inline: true,
  atom: true,      // Treat as a single unit, no editable content inside

  addOptions() {
    return {
      HTMLAttributes: {
        class: 'inline-block align-middle', // Default styling
      },
    };
  },

  addAttributes() {
    return {
      html: {
        default: '',
      },
      viewBox: {
        default: '0 0 24 24',
      },
      width: {
        default: null,
      },
      height: {
        default: null,
      },
      fill: {
        default: 'none',
      },
      stroke: {
        default: 'currentColor',
      },
      class: {
        default: null,
      },
      style: {
        default: null,
      },
      xmlns: {
        default: 'http://www.w3.org/2000/svg',
      }
    };
  },

  parseHTML() {
    return [
      {
        tag: 'svg',
        priority: 60,
        getAttrs: (element) => {
          if (!(element instanceof Element)) {
            return false;
          }
          
          // Capture all standard attributes
          const attrs: Record<string, any> = {
            html: element.innerHTML, // Capture the inner content (paths, etc.)
          };

          // Copy attributes
          if (element.getAttribute('viewBox')) attrs.viewBox = element.getAttribute('viewBox');
          if (element.getAttribute('width')) attrs.width = element.getAttribute('width');
          if (element.getAttribute('height')) attrs.height = element.getAttribute('height');
          if (element.getAttribute('fill')) attrs.fill = element.getAttribute('fill');
          if (element.getAttribute('stroke')) attrs.stroke = element.getAttribute('stroke');
          if (element.getAttribute('class')) attrs.class = element.getAttribute('class');
          if (element.getAttribute('style')) attrs.style = element.getAttribute('style');
          if (element.getAttribute('xmlns')) attrs.xmlns = element.getAttribute('xmlns');

          return attrs;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    // We cannot easily inject HTML via standard return array for atoms.
    // relying on addNodeView is safer for content injection.
    // But for export (getHTML), we must return the correct structure.
    
    // We can't insert 'html' as an attribute, we need it as content.
    // Since it's an atom, standard PM won't render content.
    // We have to rely on a custom Node View for editor rendering,
    // and for HTML export, maybe we can trick it?
    // Actually, renderHTML is used for toDOM (export).
    // If we return a DOM node, we can set innerHTML.
    
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const { html, ...otherAttrs } = HTMLAttributes;
    
    // Apply attributes
    Object.entries(mergeAttributes(this.options.HTMLAttributes, otherAttrs)).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
         svg.setAttribute(key, String(value));
      }
    });
    
    // Retrieve innerHTML
    if (html) {
      svg.innerHTML = safeSvgInnerHtml(html);
    }
    
    return {
        // SVG root element; ProseMirror renders any DOM node, but its DOMOutputSpec
        // type (prosemirror-model >=1.25.5) narrows `dom` to HTMLElement.
        dom: svg as unknown as HTMLElement
    };
  },
  
  addNodeView() {
    return ({ node, HTMLAttributes }) => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const { html, ...otherAttrs } = HTMLAttributes; // HTMLAttributes includes node.attrs merged

        // Apply attributes from node.attrs (which are in HTMLAttributes)
        // explicitly filter out 'html' to not set it as attribute
        
        Object.entries(otherAttrs).forEach(([key, value]) => {
             // Filter internal Tiptap attributes if any?
            if (key !== 'html' && value !== null && value !== undefined) {
                svg.setAttribute(key, String(value));
            }
        });

        // Set content
        if (node.attrs.html) {
            svg.innerHTML = safeSvgInnerHtml(node.attrs.html);
        } else if (html) {
            svg.innerHTML = safeSvgInnerHtml(html);
        }

        // Add class for selection handling
        svg.classList.add('parsed-svg-node');

        return {
            dom: svg as unknown as HTMLElement,
            // ignoreMutation to prevent re-rendering on internal changes if possible, 
            // but for atoms it's usually fine.
        };
    };
  }
});
