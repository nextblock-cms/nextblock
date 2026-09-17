import Link from 'next/link';

interface CtaWidgetRendererProps {
  text: string;
  // Read straight from `data-url` on stored HTML, so it can be missing at runtime.
  url?: string;
  style: 'primary' | 'secondary';
  size: 'fit-content' | 'full-width';
  textAlign: 'left' | 'center' | 'right';
}

const CtaWidgetRenderer = ({ text, url, style, size, textAlign }: CtaWidgetRendererProps) => {
  const buttonClasses: { [key: string]: string } = {
    primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
    secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  };

  const sizeClasses: { [key: string]: string } = {
    'fit-content': 'w-auto',
    'full-width': 'w-full',
  };


  const textAlignClasses: { [key: string]: string } = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right',
  };

  // `<Link href={undefined}>` throws inside next/link and takes the whole page render down
  // with it. A CTA whose `data-url` was lost (hand-edited or MCP-authored HTML) renders
  // nothing instead.
  if (!url) return null;

  return (
    <div className={`p-2 ${textAlignClasses[textAlign] || textAlignClasses.left}`}>
      <Link href={url} className={`inline-block px-4 py-2 rounded-md ${buttonClasses[style] || buttonClasses.primary} ${sizeClasses[size] || sizeClasses['fit-content']}`}>
        {text}
      </Link>
    </div>
  );
};

export default CtaWidgetRenderer;
