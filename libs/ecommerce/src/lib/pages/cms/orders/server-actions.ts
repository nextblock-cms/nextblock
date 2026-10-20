'use server';

import { createClient } from '@nextblock-cms/db/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { applyOrderInventoryDeduction } from '../../../order-inventory';
import { assignInvoiceMetadata } from '../../../invoice-server';

const MANAGEABLE_ORDER_STATUSES = [
    'pending',
    'trial',
    'paid',
    'shipped',
    'cancelled',
    'refunded',
] as const;

export type ManageableOrderStatus = (typeof MANAGEABLE_ORDER_STATUSES)[number];

async function requireOrderManager() {
    const supabase = createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
        return { error: 'Unauthorized' as const };
    }

    const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();

    if (profileError || !profile || !['ADMIN', 'WRITER'].includes(profile.role)) {
        return { error: 'Forbidden' as const };
    }

    return { supabase, user, role: profile.role as 'ADMIN' | 'WRITER' };
}

// Financial transitions (recording payment, refunds, cancellation) are ADMIN-only; a WRITER
// may move an order through fulfillment (processing/shipped) but must not be able to mark an
// order paid or refunded. Mirrors the ADMIN gate on coupons/taxes/payments config.
const ADMIN_ONLY_ORDER_STATUSES: ReadonlySet<ManageableOrderStatus> = new Set([
    'paid',
    'cancelled',
    'refunded',
]);

function createAdminSupabaseClient() {
    // Accept the Vercel Marketplace integration's new key names too.
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;

    if (!serviceRoleKey || !supabaseUrl) {
        throw new Error('Server configuration error');
    }

    return createSupabaseClient(supabaseUrl, serviceRoleKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    });
}

export async function markOrderAsPaid(orderId: string): Promise<{ success: boolean; error?: string }> {
    return updateOrderStatus(orderId, 'paid');
}

export async function updateOrderStatus(
    orderId: string,
    nextStatus: ManageableOrderStatus
): Promise<{ success: boolean; error?: string }> {
    const auth = await requireOrderManager();

    if ('error' in auth) {
        return { success: false, error: auth.error };
    }

    if (!MANAGEABLE_ORDER_STATUSES.includes(nextStatus)) {
        return { success: false, error: 'Invalid order status' };
    }

    if (ADMIN_ONLY_ORDER_STATUSES.has(nextStatus) && auth.role !== 'ADMIN') {
        return { success: false, error: 'Forbidden' };
    }

    let adminSupabase;

    try {
        adminSupabase = createAdminSupabaseClient();
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Server configuration error',
        };
    }

    const { data: updatedData, error } = await adminSupabase
        .from('orders')
        .update({ status: nextStatus })
        .eq('id', orderId)
        .select();

    if (error) {
        console.error('Order status update error:', error);
        return { success: false, error: error.message };
    }

    if (!updatedData || updatedData.length === 0) {
        return { success: false, error: 'Order not found or update failed.' };
    }

    if (nextStatus === 'paid') {
        await assignInvoiceMetadata({
            orderId,
            client: adminSupabase as any,
        });
        await applyOrderInventoryDeduction(adminSupabase as any, orderId);
    }

    return { success: true };
}
