'use client';

// Gates third-party analytics behind explicit consent. Until the visitor opts
// in, this renders null -> the GTM chunk is never imported and the network tab
// shows zero analytics bytes, preserving the Lighthouse budget.
import { useEffect, useRef, useState } from 'react';
import { DeferredGoogleTagManager } from '../DeferredGoogleTagManager';
import { DeferredGoogleAnalytics } from '../DeferredGoogleAnalytics';
import { CONSENT_CHANGE_EVENT, readConsent } from '../../lib/privacy/consent-client';

interface ConsentGatedAnalyticsProps {
  gtmId?: string;
  gaMeasurementId?: string;
  customScripts?: string;
  nonce?: string;
}

/** Recreate <script> elements from admin-provided markup so they actually run. */
function injectCustomScripts(markup: string, nonce?: string) {
  const parsed = new DOMParser().parseFromString(markup, 'text/html');
  parsed.querySelectorAll('script').forEach((source) => {
    const script = document.createElement('script');
    for (const attr of Array.from(source.attributes)) {
      script.setAttribute(attr.name, attr.value);
    }
    if (nonce) script.setAttribute('nonce', nonce);
    if (source.textContent) script.textContent = source.textContent;
    document.head.appendChild(script);
  });
}

export function ConsentGatedAnalytics({
  gtmId,
  gaMeasurementId,
  customScripts,
  nonce,
}: ConsentGatedAnalyticsProps) {
  // The sandbox's admin login is public: a GTM container or custom script saved there would run
  // with the nonce for every later visitor and could read the OpenRouter key kept in localStorage.
  // GA4 is blocked too; the sandbox's settings reset every 15 minutes anyway.
  const blocked = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
  const [analyticsAllowed, setAnalyticsAllowed] = useState(false);
  const injectedRef = useRef(false);

  useEffect(() => {
    const sync = () => setAnalyticsAllowed(Boolean(readConsent()?.analytics));
    sync();
    window.addEventListener(CONSENT_CHANGE_EVENT, sync);
    return () => window.removeEventListener(CONSENT_CHANGE_EVENT, sync);
  }, []);

  useEffect(() => {
    if (blocked || !analyticsAllowed || injectedRef.current) return;
    const markup = customScripts?.trim();
    if (!markup) return;
    injectedRef.current = true;
    try {
      injectCustomScripts(markup, nonce);
    } catch (error) {
      console.error('Failed to inject consented custom scripts:', error);
    }
  }, [analyticsAllowed, blocked, customScripts, nonce]);

  if (blocked) return null;
  if (!analyticsAllowed) return null;
  if (!gtmId && !gaMeasurementId) return null;
  return (
    <>
      {gtmId && <DeferredGoogleTagManager gtmId={gtmId} nonce={nonce} />}
      {gaMeasurementId && (
        <DeferredGoogleAnalytics gaId={gaMeasurementId} nonce={nonce} />
      )}
    </>
  );
}
