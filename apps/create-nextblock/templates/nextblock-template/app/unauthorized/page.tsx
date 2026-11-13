// app/unauthorized/page.tsx
'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useLabel } from '../../lib/i18n/use-label';

/**
 * Reasons the partner portal sends here (`requireRetailerPage()` in lib/affiliates/retailer-actor.ts):
 * a staff account opened /portal/retailer, or a suspended partner signed in. Each gets its own
 * explanation instead of the raw code.
 */
const PARTNER_REASONS = new Set(['retailer_only', 'retailer_suspended']);

export default function UnauthorizedPage() {
  const searchParams = useSearchParams();
  const label = useLabel();
  const reason = searchParams.get('reason');
  const error = searchParams.get('error');
  const path = searchParams.get('path');
  const required = searchParams.get('required');
  const codeClass = 'rounded bg-muted p-1 break-all';
  const isPartnerReason = reason !== null && PARTNER_REASONS.has(reason);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen text-center p-4">
      <h1 className="text-4xl font-bold text-destructive mb-4">
        {label('unauthorized.title', 'Access Denied', 'Accès refusé')}
      </h1>
      <p className="text-xl mb-2">
        {label(
          'unauthorized.description',
          'You do not have the necessary permissions to view this page.',
          "Vous n'avez pas les autorisations nécessaires pour consulter cette page."
        )}
      </p>
      {path && (
        <p className="text-md text-muted-foreground">
          {label('unauthorized.requested_path', 'Requested path:', 'Chemin demandé :')}{' '}
          <code translate="no" className={codeClass}>{path}</code>
        </p>
      )}
      {required && (
        <p className="text-md text-muted-foreground">
          {label('unauthorized.required_roles', 'Required role(s):', 'Rôle(s) requis :')}{' '}
          <code translate="no" className={codeClass}>
            {required.split(',').join(` ${label('unauthorized.or', 'OR', 'OU')} `)}
          </code>
        </p>
      )}
      {reason === 'retailer_only' && (
        <p className="text-md text-muted-foreground mt-1 mb-6 max-w-xl">
          {label(
            'unauthorized.retailer_only',
            'The partner portal is for partner accounts only. Staff accounts manage partners from the CMS.',
            'Le portail partenaire est réservé aux comptes partenaires. Les comptes du personnel gèrent les partenaires à partir du CMS.'
          )}
        </p>
      )}
      {reason === 'retailer_suspended' && (
        <p className="text-md text-muted-foreground mt-1 mb-6 max-w-xl">
          {label(
            'unauthorized.retailer_suspended',
            'Your partner account is suspended, so the partner portal is unavailable. Contact the store if you think this is a mistake.',
            "Votre compte partenaire est suspendu : le portail partenaire n'est donc pas accessible. Communiquez avec la boutique si vous croyez qu'il s'agit d'une erreur."
          )}
        </p>
      )}
      {reason && !isPartnerReason && (
        <p className="text-sm text-muted-foreground mt-1">
          {label('unauthorized.details', 'Details:', 'Détails :')} {reason}
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive mt-1">
          {label('unauthorized.error_code', 'Error code:', "Code d'erreur :")} {error}
        </p>
      )}
      {!isPartnerReason && (
        <p className="mb-6 mt-4">
          {label(
            'unauthorized.contact_admin',
            'Please contact your administrator if you believe this is an error.',
            "Veuillez communiquer avec votre administrateur si vous croyez qu'il s'agit d'une erreur."
          )}
        </p>
      )}
      <Link
        href="/"
        className="rounded bg-primary px-6 py-3 text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {label('unauthorized.go_home', 'Go to Homepage', "Retour à l'accueil")}
      </Link>
    </div>
  );
}
