import type { Database } from '@nextblock-cms/db';

export type Logo = Database['public']['Tables']['logos']['Row'] & {
  site_title?: string | null;
  media: Database['public']['Tables']['media']['Row'] | null;
};
