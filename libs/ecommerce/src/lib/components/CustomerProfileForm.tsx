'use client';

import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  AccountNavigationLink,
  AccountNavigationMenu,
} from './AccountNavigationMenu';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@nextblock-cms/ui/avatar';
import { Button } from '@nextblock-cms/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@nextblock-cms/ui/card';
import { Checkbox } from '@nextblock-cms/ui/checkbox';
import { Input } from '@nextblock-cms/ui/input';
import { Label } from '@nextblock-cms/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nextblock-cms/ui/select';
import { Separator } from '@nextblock-cms/ui/separator';
import { updateProfile, type ProfileUpdateData } from '../server-actions/customer-actions';
import { addressesMatch, emptyCustomerAddress, normalizeCustomerAddress } from '../customer';
import { createClient, type Database } from '@nextblock-cms/db';
import { Globe, Phone, User as UserIcon, Upload } from 'lucide-react';
import { useTranslations } from '@nextblock-cms/utils';
import { countries, normalizeCountryCode } from '../countries';

type UserRole = Database['public']['Enums']['user_role'];

// Resolve a media row's storage key to a usable URL across either storage backend
// (Cloudflare R2 or native Supabase Storage). Mirrors the resolver used elsewhere
// in libs/ecommerce (variation-utils, invoice-server). NEXT_PUBLIC_SUPABASE_URL is
// always set in a working deployment, so avatars resolve even without R2.
function resolveMediaUrl(path?: string | null): string | null {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  if (process.env.NEXT_PUBLIC_R2_BASE_URL) {
    return `${process.env.NEXT_PUBLIC_R2_BASE_URL}/${path}`;
  }
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/media/${path}`;
  }
  return path;
}

export interface ExtendedProfileUpdateData extends ProfileUpdateData {
  role?: UserRole;
}

interface CustomerProfileFormProps {
  initialData?: ExtendedProfileUpdateData;
  MediaPickerComponent?: React.ComponentType<any>;
  isAdmin?: boolean;
  email?: string;
  accountLinks?: AccountNavigationLink[];
  onAction?: (data: ExtendedProfileUpdateData) => Promise<{ error?: string } | void>;
  initialSuccessMessage?: string | null;
  /** Disable the admin Role selector (e.g. this is the only Admin, so its role can't be changed). */
  lockRole?: boolean;
  /** Explanation shown under the disabled Role selector. */
  lockRoleReason?: string;
}

function buildAddressDefaults(address?: ExtendedProfileUpdateData['billing_address']) {
  return {
    company_name: address?.company_name || '',
    recipient_name: address?.recipient_name || '',
    line1: address?.line1 || '',
    line2: address?.line2 || '',
    city: address?.city || '',
    state: address?.state || '',
    postal_code: address?.postal_code || '',
    country_code: normalizeCountryCode(address?.country_code) || 'CA',
  };
}

function AddressFields({
  prefix,
  title,
  register,
}: {
  prefix: 'billing_address' | 'shipping_address';
  title: string;
  register: ReturnType<typeof useForm<ExtendedProfileUpdateData>>['register'];
}) {
  const { t } = useTranslations();
  const companyNameLabel =
    t('company_name') === 'company_name' ? 'Company name' : t('company_name');

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div>
        <h3 className="text-lg font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">
          {t('profile_address_defaults_help')}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-company_name`}>{companyNameLabel}</Label>
          <Input id={`${prefix}-company_name`} {...register(`${prefix}.company_name`)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-recipient_name`}>{t('full_name')}</Label>
          <Input id={`${prefix}-recipient_name`} {...register(`${prefix}.recipient_name`)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-country_code`}>{t('country')}</Label>
          <select
            id={`${prefix}-country_code`}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            {...register(`${prefix}.country_code`)}
          >
            {countries.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${prefix}-line1`}>{t('address_line_1')}</Label>
        <Input id={`${prefix}-line1`} {...register(`${prefix}.line1`)} />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${prefix}-line2`}>{t('address_line_2')}</Label>
        <Input id={`${prefix}-line2`} {...register(`${prefix}.line2`)} />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-city`}>{t('city')}</Label>
          <Input id={`${prefix}-city`} {...register(`${prefix}.city`)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-state`}>{t('state_province')}</Label>
          <Input id={`${prefix}-state`} {...register(`${prefix}.state`)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-postal_code`}>{t('postal_zip_code')}</Label>
          <Input id={`${prefix}-postal_code`} {...register(`${prefix}.postal_code`)} />
        </div>
      </div>
    </div>
  );
}

export function CustomerProfileForm({
  initialData,
  MediaPickerComponent,
  isAdmin,
  email,
  accountLinks,
  onAction,
  initialSuccessMessage,
  lockRole,
  lockRoleReason,
}: CustomerProfileFormProps) {
  const { t } = useTranslations();
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(
    initialSuccessMessage ? { type: 'success', text: initialSuccessMessage } : null
  );
  const derivedUseBillingForShipping =
    initialData?.use_billing_for_shipping ??
    (!initialData?.shipping_address ||
      addressesMatch(initialData?.billing_address, initialData?.shipping_address));

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    watch,
    reset,
  } = useForm<ExtendedProfileUpdateData>({
    defaultValues: {
      full_name: initialData?.full_name || '',
      avatar_url: initialData?.avatar_url || '',
      website: initialData?.website || '',
      phone: initialData?.phone || '',
      role: initialData?.role,
      use_billing_for_shipping: derivedUseBillingForShipping,
      billing_address: buildAddressDefaults(initialData?.billing_address),
      shipping_address: buildAddressDefaults(initialData?.shipping_address),
    },
  });

  React.useEffect(() => {
    if (!initialData) {
      return;
    }

    reset({
      full_name: initialData.full_name || '',
      avatar_url: initialData.avatar_url || '',
      website: initialData.website || '',
      phone: initialData.phone || '',
      role: initialData.role,
      use_billing_for_shipping:
        initialData.use_billing_for_shipping ??
        (!initialData.shipping_address ||
          addressesMatch(initialData.billing_address, initialData.shipping_address)),
      billing_address: buildAddressDefaults(initialData.billing_address),
      shipping_address: buildAddressDefaults(initialData.shipping_address),
    });
  }, [initialData, reset]);

  React.useEffect(() => {
    if (initialSuccessMessage) {
      setMsg({ type: 'success', text: initialSuccessMessage });
    }
  }, [initialSuccessMessage]);

  React.useEffect(() => {
    const supabase = createClient();

    const checkUser = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        return;
      }

      if (!getValues('full_name') && user.user_metadata?.full_name) {
        setValue('full_name', user.user_metadata.full_name);
      }
    };

    checkUser();
  }, [getValues, setValue]);

  const handleMediaSelect = (media: any) => {
    const url = resolveMediaUrl(media?.object_key ?? media?.file_path);
    if (url) {
      setValue('avatar_url', url);
    }
  };

  const onSubmit = async (data: ExtendedProfileUpdateData) => {
    setLoading(true);
    setMsg(null);

    const billingAddress = normalizeCustomerAddress(data.billing_address) ?? emptyCustomerAddress();
    const shippingAddress = data.use_billing_for_shipping
      ? billingAddress
      : normalizeCustomerAddress(data.shipping_address);

    try {
      const payload: ExtendedProfileUpdateData = {
        ...data,
        billing_address: billingAddress,
        shipping_address: shippingAddress,
      };

      if (onAction) {
        const result = await onAction(payload);
        if (result?.error) {
          throw new Error(result.error);
        }
      } else {
        await updateProfile(payload);
      }

      setMsg({ type: 'success', text: t('profile_updated_success') });
    } catch (error: any) {
      if (error.message === 'NEXT_REDIRECT' || error.message?.includes('NEXT_REDIRECT')) {
        return;
      }

      console.error(error);
      // Never `error.message`: the action throws on the server, and in production Next swaps
      // a thrown message for a long English sentence about digests, so the translated
      // fallback never showed.
      setMsg({ type: 'error', text: t('profile_update_failed') });
    } finally {
      setLoading(false);
    }
  };

  const useBillingForShipping = watch('use_billing_for_shipping');

  return (
    <div className="grid gap-6 md:grid-cols-12 max-w-5xl mx-auto">
      <Card className="md:col-span-4 h-fit">
        <CardHeader>
          <CardTitle className="text-xl">{t('public_profile')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center text-center space-y-4">
          <div className="relative group">
            <Avatar className="h-32 w-32 border-4 border-muted">
              <AvatarImage src={watch('avatar_url') || undefined} alt={watch('full_name') || ''} className="object-cover" />
              <AvatarFallback className="text-4xl bg-secondary">
                {watch('full_name')?.charAt(0)?.toUpperCase() || <UserIcon className="h-12 w-12" />}
              </AvatarFallback>
            </Avatar>
            {MediaPickerComponent && (
              // Hover alone hid this from keyboard focus (focusable but invisible) and from
              // touch screens, which have no hover at all.
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity bg-black/40 rounded-full cursor-pointer">
                <MediaPickerComponent
                  triggerLabel={
                    <>
                      <Upload className="h-6 w-6 text-white" />
                      <span className="sr-only">
                        {t('profile_change_avatar') === 'profile_change_avatar'
                          ? 'Change profile picture'
                          : t('profile_change_avatar')}
                      </span>
                    </>
                  }
                  triggerVariant="ghost"
                  title={t('customer_profile')}
                  onSelect={handleMediaSelect}
                  accept={(m: any) => m.file_type.startsWith('image/')}
                  hideTrigger={false}
                />
              </div>
            )}
          </div>

          {!MediaPickerComponent && (
            <div className="w-full">
              <Label htmlFor="avatar_url" className="sr-only">
                {t('avatar_url')}
              </Label>
              <Input id="avatar_url" type="url" autoComplete="off" {...register('avatar_url')} placeholder="https://…" className="mt-2" />
            </div>
          )}

          <div className="w-full space-y-1 text-left mt-4">
            <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              {t('identity')}
            </div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-lg">{watch('full_name') || t('full_name')}</span>
            </div>
          </div>

          {accountLinks?.length ? (
            <AccountNavigationMenu
              links={accountLinks}
              className="mt-2 text-left"
            />
          ) : null}
        </CardContent>
      </Card>

      <Card className="md:col-span-8">
        <form onSubmit={handleSubmit(onSubmit)}>
          <CardHeader>
            <CardTitle>{t('details')}</CardTitle>
          </CardHeader>

          <CardContent className="space-y-6">
            {email && (
              <div className="space-y-2">
                <Label htmlFor="email">
                  {t('email') === 'email' ? 'Email' : t('email')} (
                  {t('read_only') === 'read_only' ? 'read-only' : t('read_only')})
                </Label>
                <Input id="email" value={email} readOnly disabled className="bg-muted/50" />
              </div>
            )}

            <div className="rounded-xl border bg-muted/20 p-4 text-sm text-muted-foreground">
                {t('profile_basic_info_help')}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="full_name" className="flex items-center gap-2">
                  <UserIcon className="h-4 w-4" /> {t('full_name')}
                </Label>
                <Input id="full_name" autoComplete="name" {...register('full_name')} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone" className="flex items-center gap-2">
                  <Phone className="h-4 w-4" /> {t('phone_number')}
                </Label>
                <Input id="phone" type="tel" inputMode="tel" autoComplete="tel" {...register('phone')} />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="website" className="flex items-center gap-2">
                <Globe className="h-4 w-4" /> {t('website')}
              </Label>
              <Input id="website" type="url" autoComplete="url" {...register('website')} placeholder="https://example.com" />
            </div>

            <Separator className="my-2" />

            <AddressFields prefix="billing_address" title={t('billing_address')} register={register} />

            <div className="flex items-center space-x-3 rounded-lg border p-4">
              <Checkbox
                id="use_billing_for_shipping"
                checked={!!useBillingForShipping}
                onCheckedChange={(checked) =>
                  setValue('use_billing_for_shipping', !!checked, { shouldDirty: true })
                }
              />
              <div className="space-y-1">
                <Label htmlFor="use_billing_for_shipping" className="cursor-pointer">
                  {t('use_billing_for_shipping')}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {t('profile_use_billing_for_shipping_help')}
                </p>
              </div>
            </div>

            {!useBillingForShipping && (
              <AddressFields
                prefix="shipping_address"
                title={t('shipping_address')}
                register={register}
              />
            )}

            {msg && (
              <div
                role={msg.type === 'error' ? 'alert' : 'status'}
                className={`mt-4 rounded-xl border p-4 text-sm ${
                  msg.type === 'success'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-red-200 bg-red-50 text-red-700'
                }`}
              >
                {msg.text}
              </div>
            )}

            {isAdmin && (
              <div className="border-t pt-4 mt-4">
                <h3 className="text-sm font-medium mb-3">Admin Settings</h3>
                <div className="grid gap-2">
                  <Label htmlFor="role">Role</Label>
                  <Select
                    value={watch('role') || 'USER'}
                    onValueChange={(val: UserRole) => setValue('role', val)}
                    disabled={lockRole}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USER">User</SelectItem>
                      <SelectItem value="WRITER">Writer</SelectItem>
                      <SelectItem value="ADMIN">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                  {lockRole && (
                    <p className="text-xs text-muted-foreground">
                      {lockRoleReason ||
                        "This is the only Admin account, so its role can't be changed. Promote another user to Admin first."}
                    </p>
                  )}
                </div>
              </div>
            )}
          </CardContent>

          <CardFooter className="flex justify-end">
            <Button type="submit" disabled={loading} size="lg">
              {loading ? t('saving') : t('save_changes')}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
