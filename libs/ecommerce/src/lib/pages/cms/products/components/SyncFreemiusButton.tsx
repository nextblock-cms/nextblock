'use client';

import { useState } from 'react';
import { Button } from '@nextblock-cms/ui';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { triggerFreemiusSync } from '../actions';

// The public demo refuses Sync from Freemius (its reset syncs the demo catalog), so the button is off there.
const SYNC_OFF_ON_DEMO = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
const SYNC_OFF_ON_DEMO_TITLE = 'Sync from Freemius is turned off on the public demo; the demo resets every 15 minutes.';

export function SyncFreemiusButton({ title = 'Sync Full Store' }: { title?: string }) {
  const [isPending, setIsPending] = useState(false);

  const handleSync = async () => {
    setIsPending(true);
    try {
      const result = await triggerFreemiusSync();
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`Full store sync complete! Found ${result.data?.count || 0} products.`);
      }
    } catch (err: any) {
      toast.error(err.message || 'An unexpected error occurred during sync');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Button 
      variant="secondary" 
      onClick={handleSync}
      disabled={isPending || SYNC_OFF_ON_DEMO}
      title={SYNC_OFF_ON_DEMO ? SYNC_OFF_ON_DEMO_TITLE : undefined}
      className="gap-2"
    >
      <RefreshCw className={`w-4 h-4 ${isPending ? 'animate-spin' : ''}`} />
      {isPending ? 'Syncing...' : title}
    </Button>
  );
}
