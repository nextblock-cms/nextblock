'use server';

import 'server-only';

import { applyOrderInventoryDeduction } from '../../../order-inventory';
import { assignInvoiceMetadata } from '../../../invoice-server';
import { requireEcomAdmin, requireEcomStaff } from '../../../server-actions/require-ecom-role';

const MANAGEABLE_ORDER_STATUSES = [
    'pending',
    'trial',
    'paid',
    'shipped',
    'cancelled',
    'refunded',
] as const;

export type ManageableOrderStatus = (typeof MANAGEABLE_ORDER_STATUSES)[number];

// Financial transitions (recording payment, refunds, cancellation) are ADMIN-only; a WRITER
// may move an order through fulfillment (processing/shipped) but must not be able to mark an
// order paid or refunded. Mirrors the ADMIN gate on coupons/taxes/payments config. Since 02030
// these are also the affiliate ledger's transitions: paid records a partner's commission, and
// refunded or cancelled voids it.
const ADMIN_ONLY_ORDER_STATUSES: ReadonlySet<ManageableOrderStatus> = new Set([
    'paid',
    'cancelled',
    'refunded',
]);

type OrderManagerClient = Awaited<ReturnType<typeof requireEcomStaff>>;

type OrderManagerGate =
    | { client: OrderManagerClient }
    | { error: 'Unauthorized' | 'Forbidden' | 'Server configuration error' };

/**
 * The service-role client for an order status write, from the lib's gate
 * (server-actions/require-ecom-role.ts): a staff session (ADMIN or WRITER) that has passed its
 * enrolled second factor, and an ADMIN for the financial statuses. The service role bypasses
 * RLS (02023 puts the orders ADMIN policies behind is_admin_mfa()), so this check is the whole
 * authorization. It used to read the role with the cookie client and build the service client
 * itself, so a first factor alone could mark an order paid, refunded or cancelled.
 */
async function requireOrderManager(nextStatus: ManageableOrderStatus): Promise<OrderManagerGate> {
    try {
        const client = ADMIN_ONLY_ORDER_STATUSES.has(nextStatus)
            ? await requireEcomAdmin()
            : await requireEcomStaff();
        return { client };
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'Unauthorized' || message === 'Forbidden') {
            return { error: message };
        }
        console.error('Order status update: the service client is unavailable:', error);
        return { error: 'Server configuration error' };
    }
}

export async function markOrderAsPaid(orderId: string): Promise<{ success: boolean; error?: string }> {
    return updateOrderStatus(orderId, 'paid');
}

export async function updateOrderStatus(
    orderId: string,
    nextStatus: ManageableOrderStatus
): Promise<{ success: boolean; error?: string }> {
    const auth = await requireOrderManager(nextStatus);

    if ('error' in auth) {
        return { success: false, error: auth.error };
    }

    if (!MANAGEABLE_ORDER_STATUSES.includes(nextStatus)) {
        return { success: false, error: 'Invalid order status' };
    }

    const adminSupabase = auth.client;

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
            client: adminSupabase,
        });
        await applyOrderInventoryDeduction(adminSupabase, orderId);
    }

    return { success: true };
}
