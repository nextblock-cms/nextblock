// app/unauthorized/page.tsx
'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useLabel } from '../../lib/i18n/use-label';

export default function UnauthorizedPage() {
  const searchParams = useSearchParams();
  const label = useLabel();
  const reason = searchParams.get('reason');
  const error = searchParams.get('error');
  const path = searchParams.get('path');
  const required = searchParams.get('required');
  const codeClass = 'rounded bg-muted p-1 break-all';

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
      {reason && (
        <p className="text-sm text-muted-foreground mt-1">
          {label('unauthorized.details', 'Details:', 'Détails :')} {reason}
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive mt-1">
          {label('unauthorized.error_code', 'Error code:', "Code d'erreur :")} {error}
        </p>
      )}
      <p className="mb-6 mt-4">
        {label(
          'unauthorized.contact_admin',
          'Please contact your administrator if you believe this is an error.',
          "Veuillez communiquer avec votre administrateur si vous croyez qu'il s'agit d'une erreur."
        )}
      </p>
      <Link
        href="/"
        className="rounded bg-primary px-6 py-3 text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {label('unauthorized.go_home', 'Go to Homepage', "Retour à l'accueil")}
      </Link>
    </div>
  );
}
