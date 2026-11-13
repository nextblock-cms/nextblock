/*
 * The loading behaviour of an external script is the admin's choice, stored per row
 * as `load_strategy` (default / defer / async). A blocking load is sometimes the
 * required one — anti-flicker snippets and consent gates have to run before render —
 * so this file renders what was asked for instead of forcing `defer` on everything.
 */
/* eslint-disable @next/next/no-sync-scripts */
import React from 'react';

import { escapeInlineScript, type SiteScript, type SiteScriptPlacement } from '../lib/site-scripts/types';

interface SiteScriptsProps {
  nonce: string;
  placement: SiteScriptPlacement;
  scripts: SiteScript[];
}

/**
 * Render the admin-authored site scripts for one injection point.
 *
 * Emitted as plain <script> elements rather than next/script: these are arbitrary
 * author-supplied snippets that frequently expect to run at a specific position in
 * the document, and next/script's strategies would relocate them. The CSP nonce is
 * applied here so the snippets satisfy the policy without it needing 'unsafe-inline'.
 */
export default function SiteScripts({ nonce, placement, scripts }: SiteScriptsProps) {
  // The sandbox's admin login is public: a script saved there would run for every later visitor, /cms and the partner portal included, and could read the OpenRouter key they keep in localStorage.
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') return null;

  const forPlacement = scripts.filter((script) => script.placement === placement);

  if (forPlacement.length === 0) {
    return null;
  }

  return (
    <>
      {forPlacement.map((script) =>
        script.src ? (
          <script
            key={script.id}
            src={script.src}
            nonce={nonce || undefined}
            {...(script.load_strategy === 'async' ? { async: true } : {})}
            {...(script.load_strategy === 'defer' ? { defer: true } : {})}
            data-nb-script={script.id}
          />
        ) : (
          <script
            key={script.id}
            nonce={nonce || undefined}
            data-nb-script={script.id}
            dangerouslySetInnerHTML={{ __html: escapeInlineScript(script.code) }}
          />
        )
      )}
    </>
  );
}
