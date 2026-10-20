'use server'

import { createClient, getServiceRoleSupabaseClient } from "@nextblock-cms/db/server";
import { formatDistanceToNow, startOfMonth, subMonths } from 'date-fns';
import { getCmsActor, isCmsStaffRole } from '../../../lib/auth/cms-actor';

export type DashboardStats = {
  totalPages: number;
  totalPosts: number;
  totalUsers: number;
  isEcommerceActive: boolean;
  isAiActive: boolean;
  ecommerce?: {
    monthlyRevenue: number;
    taxLiability: number;
    recentSales: any[];
    revenueTrend?: {
      value: string;
      positive: boolean;
    };
  };
  recentContent: {
    type: 'post' | 'page';
    title: string;
    author: string;
    date: string;
    status: string;
  }[];
  scheduledContent: {
    title: string;
    date: string;
    type: string;
  }[];
};

type ServiceClient = ReturnType<typeof getServiceRoleSupabaseClient>;

/**
 * The service-role client, or null when the service key is not configured. Every read below
 * that needs it then degrades — no active packages, a zeroed ledger, cookie-client fallbacks
 * for the staff reads — instead of failing the whole dashboard, which is how the screen
 * already behaved when a read failed.
 */
function resolveServiceClient(): ServiceClient | null {
  try {
    return getServiceRoleSupabaseClient();
  } catch (err) {
    console.error('Dashboard service-role client unavailable:', err);
    return null;
  }
}

/**
 * The premium packages that are currently active on this install.
 *
 * Read with the service role, not the signed-in (cookie) client. Migration 02022 gates
 * `package_activations` SELECT behind `public.is_admin_mfa()` (ADMIN *and* an aal2 session
 * whenever an MFA factor is enrolled). An ADMIN who signed in with "remember this device"
 * passes the app's own 2FA gate (evaluateTwoFactor is satisfied by the trusted device) while
 * the Supabase session stays aal1, so a cookie-client read would now return nothing and the
 * dashboard would wrongly treat every premium feature as inactive. This surface already sits
 * behind the /cms session + 2FA gate (app/cms/layout.tsx), only derives feature-availability
 * flags from the rows (package_id + status, never the license key), and leaves the RLS policy
 * untouched so direct PostgREST access is still protected. Mirrors verifyPackageOnline.
 *
 * Best-effort: a missing service key or a query error yields an empty set (every feature
 * reads as inactive), matching the dashboard's previous behaviour when the read failed.
 */
async function getActivePackageIds(admin: ServiceClient | null): Promise<Set<string>> {
  if (!admin) return new Set();
  try {
    const { data, error } = await admin
      .from('package_activations')
      .select('package_id, status')
      .eq('status', 'active');

    if (error) {
      console.error('Dashboard package activation read failed:', error);
      return new Set();
    }

    return new Set((data ?? []).map((a) => a.package_id));
  } catch (err) {
    console.error('Dashboard package activation read failed:', err);
    return new Set();
  }
}

export async function getDashboardStats(): Promise<DashboardStats> {
  // A server action is a public POST dispatched by its id, and the privileged reads below
  // bypass RLS, so the caller is verified here rather than trusted from the /cms URL gate.
  const actor = await getCmsActor();
  if (!actor) throw new Error('Unauthorized');
  if (!isCmsStaffRole(actor.role)) throw new Error('Forbidden');

  const supabase = createClient();
  const admin = resolveServiceClient();
  // Rows that migration 02023 gates behind is_admin_mfa() — profiles beyond the caller's own
  // row, orders — are read with the service role so an ADMIN on an aal1 "remember this
  // device" session, who passes the app's own 2FA gate, still gets their numbers. The caller
  // is verified staff above; lib/auth/cms-actor.ts has the full reasoning. The profile reads
  // were open to every ADMIN and WRITER already, so the cookie client is their fallback when
  // the service key is missing.
  const staffReader = admin ?? supabase;
  // Orders stay ADMIN-only. The cookie client gave a WRITER nothing there, and the zeroed
  // ledger below keeps that; the service role is never used for a WRITER's order read.
  const orderReader = actor.role === 'ADMIN' ? admin : null;

  const now = new Date().toISOString();
  const firstOfMonth = startOfMonth(new Date()).toISOString();
  const lastMonthStart = startOfMonth(subMonths(new Date(), 1)).toISOString();

  // 1. Check Package Activations (which premium features are active)
  const activePackages = await getActivePackageIds(admin);
  const isEcommerceActive = activePackages.has('ecommerce');
  const isAiActive = activePackages.has('cortex-ai');

  // 2. Parallelize Core Queries
  const queries: PromiseLike<any>[] = [
    supabase.from('pages').select('*', { count: 'exact', head: true }),
    supabase.from('posts').select('*', { count: 'exact', head: true }),
    staffReader.from('profiles').select('*', { count: 'exact', head: true }),

    // Recent Posts (author names are resolved separately below)
    supabase.from('posts')
      .select('title, status, updated_at, created_at, author_id')
      .order('updated_at', { ascending: false })
      .limit(5),

    // Recent Pages
    supabase.from('pages')
      .select('title, status, updated_at, created_at')
      .order('updated_at', { ascending: false })
      .limit(5),

    // Scheduled Posts
    supabase.from('posts')
      .select('title, published_at')
      .gt('published_at', now)
      .order('published_at', { ascending: true })
      .limit(5)
  ];

  // 3. Add Ecommerce Queries if active (ADMIN only, see orderReader)
  if (isEcommerceActive && orderReader) {
    queries.push(
      // Monthly Revenue (Paid orders this month)
      orderReader.from('orders')
        .select('total')
        .eq('status', 'paid')
        .gte('created_at', firstOfMonth),

      // Tax Liability (Total taxes this month)
      orderReader.from('orders')
        .select('tax_total')
        .eq('status', 'paid')
        .gte('created_at', firstOfMonth),

      // Recent Sales Ledger
      orderReader.from('orders')
        .select(`
          id,
          total,
          currency,
          created_at,
          status,
          provider,
          customer_details,
          user_id
        `)
        .order('created_at', { ascending: false })
        .limit(10),

      // Last Month Revenue
      orderReader.from('orders')
        .select('total')
        .eq('status', 'paid')
        .gte('created_at', lastMonthStart)
        .lt('created_at', firstOfMonth)
    );
  }

  const results = await Promise.all(queries);

  // Error checking
  results.forEach((res, i) => {
    if (res.error) {
      console.error(`Dashboard query ${i} failed:`, res.error);
    }
  });

  const totalPages = results[0].count;
  const totalPosts = results[1].count;
  const totalUsers = results[2].count;
  const recentPosts = results[3].data;
  const recentPages = results[4].data;
  const scheduledPosts = results[5].data;

  let ecommerceData: DashboardStats['ecommerce'] = undefined;
  if (isEcommerceActive) {
    if (orderReader && results.length >= 10) {
      const revenueData = results[6].data;
      const taxData = results[7].data;
      const orders = (results[8].data as any[]) || [];
      const lastMonthRevenueData = results[9]?.data || [];

      // Fetch Profiles separately for orders (no direct FK between orders and profiles)
      const userIds = Array.from(new Set(orders.map(o => o.user_id).filter(Boolean)));
      const profilesMap = new Map();

      if (userIds.length > 0) {
        // `profiles` has no `email` column (it lives in auth.users); selecting one made
        // PostgREST fail the whole lookup, so the ledger never showed a customer name.
        const { data: profiles } = await orderReader
          .from('profiles')
          .select('id, full_name')
          .in('id', userIds);

        profiles?.forEach(p => profilesMap.set(p.id, p));
      }

      const recentSales = orders.map(order => ({
        ...order,
        profiles: order.user_id ? profilesMap.get(order.user_id) : null
      }));

      const monthlyRevenue = (revenueData || []).reduce((sum: number, o: any) => sum + (o.total || 0), 0);
      const taxLiability = (taxData || []).reduce((sum: number, o: any) => sum + (o.tax_total || 0), 0);
      const lastMonthRevenue = lastMonthRevenueData.reduce((sum: number, o: any) => sum + (o.total || 0), 0);

      let revenueTrend = undefined;
      if (lastMonthRevenue > 0) {
        const percentageChange = ((monthlyRevenue - lastMonthRevenue) / lastMonthRevenue) * 100;
        revenueTrend = {
          value: `${percentageChange >= 0 ? '+' : ''}${percentageChange.toFixed(1)}%`,
          positive: percentageChange >= 0
        };
      } else if (monthlyRevenue > 0) {
        revenueTrend = {
          value: '+100%',
          positive: true
        };
      } else {
        revenueTrend = {
          value: '0%',
          positive: true
        };
      }

      ecommerceData = {
        monthlyRevenue,
        taxLiability,
        recentSales,
        revenueTrend
      };
    } else {
      // A WRITER, or no service key: the ledger reads as empty, exactly what the cookie
      // client's RLS-filtered result produced before.
      ecommerceData = {
        monthlyRevenue: 0,
        taxLiability: 0,
        recentSales: [],
        revenueTrend: { value: '0%', positive: true }
      };
    }
  }

  // Author names for the recent posts. Other accounts' profiles rows sit behind
  // is_admin_mfa() since 02023, so they come from the staff reader rather than an embedded
  // `profiles(full_name)` join on the cookie client, which would read null for an aal1 admin.
  const authorIds = Array.from(
    new Set(((recentPosts as any[]) || []).map((p) => p.author_id).filter(Boolean))
  ) as string[];
  const authorNames = new Map<string, string | null>();
  if (authorIds.length > 0) {
    const { data: authors } = await staffReader
      .from('profiles')
      .select('id, full_name')
      .in('id', authorIds);
    authors?.forEach((a: { id: string; full_name: string | null }) => authorNames.set(a.id, a.full_name));
  }

  // Process Recent Content
  const combinedRecent = [
    ...(recentPosts?.map((p: any) => ({
      type: 'post' as const,
      title: p.title,
      author: (p.author_id && authorNames.get(p.author_id)) || 'Unknown',
      date: p.updated_at || p.created_at,
      status: p.status
    })) || []),
    ...(recentPages?.map((p: any) => ({
      type: 'page' as const,
      title: p.title,
      author: 'System',
      date: p.updated_at || p.created_at,
      status: p.status
    })) || [])
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
   .slice(0, 5)
   .map(item => ({
     ...item,
     date: formatDistanceToNow(new Date(item.date), { addSuffix: true })
   }));

  // Process Scheduled Content
  const processedScheduled = (scheduledPosts || []).map((p: any) => ({
    title: p.title,
    date: new Date(p.published_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    type: 'Post'
  }));

  return {
    totalPages: totalPages || 0,
    totalPosts: totalPosts || 0,
    totalUsers: totalUsers || 0,
    isEcommerceActive,
    isAiActive,
    ecommerce: ecommerceData,
    recentContent: combinedRecent,
    scheduledContent: processedScheduled
  };
}
