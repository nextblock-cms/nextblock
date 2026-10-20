import { redirect } from 'next/navigation';

import { getCmsActor, isCmsStaffRole } from '../../../lib/auth/cms-actor';
import { isEmailConfigured } from '../../../lib/config/email-settings';
import {
  getStoreContactEmail,
  resolveSellerContactEmail,
} from '../../../lib/commerce/seller-contact';
import { loadInbox, loadThreadDetail, type ThreadDetail } from './loadInbox';
import MessagesClient from './MessagesClient';

export const metadata = {
  title: 'Messages | NextBlock™ CMS',
};

// Messages arrive from the public site at any moment; a cached page would show an admin
// an empty inbox that is not.
export const dynamic = 'force-dynamic';

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; page?: string; thread?: string; handled?: string }>;
}) {
  const params = await searchParams;

  const actor = await getCmsActor();
  if (!actor) redirect('/sign-in');

  if (!isCmsStaffRole(actor.role)) {
    redirect('/unauthorized');
  }

  const isAdmin = actor.role === 'ADMIN';

  const [inbox, storeContactEmail, resolvedFallback, smtpConfigured] = await Promise.all([
    loadInbox({
      source: params.source,
      page: params.page ? Number(params.page) : 0,
      isAdmin,
      showHandled: params.handled === '1',
    }),
    isAdmin ? getStoreContactEmail() : Promise.resolve(''),
    isAdmin
      ? resolveSellerContactEmail()
      : Promise.resolve({ email: null, source: 'none' as const }),
    isEmailConfigured().catch(() => false),
  ]);

  // Only the open conversation's history is loaded, not every thread's.
  let openThread: ThreadDetail | null = null;
  if (isAdmin && params.thread) {
    openThread = await loadThreadDetail(params.thread);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Messages</h1>
        <p className="text-sm text-muted-foreground">
          Everything people send you — product enquiries, contact forms, reviews and
          comments — in one place.
        </p>
      </div>

      <MessagesClient
        inbox={inbox}
        openThread={openThread}
        isAdmin={isAdmin}
        activeSource={params.source ?? ''}
        showHandled={params.handled === '1'}
        storeContactEmail={storeContactEmail}
        resolvedFallback={{ email: resolvedFallback.email, source: resolvedFallback.source }}
        smtpConfigured={smtpConfigured}
      />
    </div>
  );
}
