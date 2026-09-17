import type { OrderCustomerDetails } from './customer';
import type { OrderTaxDetails } from './order-tax-details';

export const INVOICE_SETTINGS_KEY = 'invoice_settings';

export interface InvoiceTaxRegistration {
  label: string;
  value: string;
}

export interface InvoiceAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country_code?: string | null;
}

export interface InvoiceSettings {
  businessName: string;
  email: string;
  phone: string;
  address: InvoiceAddress;
  taxRegistrations: InvoiceTaxRegistration[];
}

export interface InvoiceLogo {
  id: string;
  name: string | null;
  url: string | null;
  width: number | null;
  height: number | null;
}

export interface InvoiceOrderItem {
  id: string;
  product_id?: string | null;
  variant_id?: string | null;
  title: string;
  description?: string | null;
  quantity: number;
  unit_amount: number;
  total_amount: number;
  sku?: string | null;
}

export interface InvoiceOrder {
  id: string;
  invoice_number: string | null;
  paid_at: string | null;
  created_at: string | null;
  currency: string;
  status: string;
  provider: string | null;
  subtotal: number;
  shipping_total: number;
  discount_total: number;
  coupon_code?: string | null;
  tax_total: number;
  total: number;
  customer_details: OrderCustomerDetails | null;
  tax_details: OrderTaxDetails | null;
  items: InvoiceOrderItem[];
}

export interface InvoicePresentationData {
  order: InvoiceOrder;
  settings: InvoiceSettings;
  logo: InvoiceLogo | null;
}

export const DEFAULT_INVOICE_SETTINGS: InvoiceSettings = {
  businessName: '',
  email: '',
  phone: '',
  address: {
    line1: '',
    line2: '',
    city: '',
    state: '',
    postal_code: '',
    country_code: 'CA',
  },
  taxRegistrations: [],
};

function cleanString(value: unknown) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function normalizeInvoiceAddress(value: unknown): InvoiceAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_INVOICE_SETTINGS.address };
  }

  const address = value as Record<string, unknown>;

  return {
    line1: cleanString(address.line1),
    line2: cleanString(address.line2),
    city: cleanString(address.city),
    state: cleanString(address.state),
    postal_code: cleanString(address.postal_code),
    country_code: cleanString(address.country_code).toUpperCase() || 'CA',
  };
}

function normalizeTaxRegistrations(value: unknown): InvoiceTaxRegistration[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }

      const item = entry as Record<string, unknown>;
      const label = cleanString(item.label);
      const registrationValue = cleanString(item.value);

      if (!label && !registrationValue) {
        return null;
      }

      return {
        label,
        value: registrationValue,
      };
    })
    .filter((entry): entry is InvoiceTaxRegistration => Boolean(entry));
}

export function normalizeInvoiceSettings(value: unknown): InvoiceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_INVOICE_SETTINGS };
  }

  const settings = value as Record<string, unknown>;

  return {
    businessName: cleanString(settings.business_name ?? settings.businessName),
    email: cleanString(settings.email),
    phone: cleanString(settings.phone),
    address: normalizeInvoiceAddress(settings.address),
    taxRegistrations: normalizeTaxRegistrations(
      settings.tax_registrations ?? settings.taxRegistrations
    ),
  };
}

export function serializeInvoiceSettings(settings: InvoiceSettings) {
  return {
    business_name: cleanString(settings.businessName),
    email: cleanString(settings.email),
    phone: cleanString(settings.phone),
    address: normalizeInvoiceAddress(settings.address),
    tax_registrations: normalizeTaxRegistrations(settings.taxRegistrations),
  };
}

export function formatInvoiceCurrency(
  amount: number,
  currency = 'usd',
  locale = 'en-US'
) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

export function formatInvoiceDate(value?: string | null, locale = 'en-US', timeZone = 'UTC') {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  // A fixed zone. Every caller is a client component that also renders on the server (the
  // orders list, the invoice, the license panel): with the ambient zone the server (UTC) and
  // a visitor west of it could format different days, which is a hydration mismatch and a
  // date that changes after load.
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(parsed);
}

export function getInvoiceAddressLines(address?: InvoiceAddress | OrderCustomerDetails['billing']) {
  if (!address) {
    return [];
  }

  const cityLine = [address.city, address.state, address.postal_code]
    .filter(Boolean)
    .join(', ')
    .replace(', ,', ',')
    .trim();

  return [
    'company_name' in address ? address.company_name || '' : '',
    'recipient_name' in address ? address.recipient_name || '' : '',
    address.line1 || '',
    address.line2 || '',
    cityLine,
    address.country_code || '',
  ].filter(Boolean);
}
