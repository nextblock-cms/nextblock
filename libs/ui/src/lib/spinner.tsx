import { Loader2 } from 'lucide-react';
import { cn } from '@nextblock-cms/utils/utils';

export interface SpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: 'sm' | 'default' | 'lg' | 'xl';
}

export function Spinner({ className, size = 'default', ...props }: SpinnerProps) {
  const sizeClasses = {
    sm: 'h-4 w-4',
    default: 'h-6 w-6',
    lg: 'h-8 w-8',
    xl: 'h-12 w-12',
  };

  return (
    <div
      role="status"
      className={cn('animate-spin text-muted-foreground', sizeClasses[size], className)}
      {...props}
    >
      <Loader2 className="h-full w-full" />
      <span className="sr-only">Loading...</span>
    </div>
  );
}
