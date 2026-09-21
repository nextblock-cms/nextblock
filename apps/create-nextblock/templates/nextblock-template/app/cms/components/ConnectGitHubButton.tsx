'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@nextblock-cms/ui';
import { startGithubConnect, pollGithubConnect } from './github-connect-actions';

/**
 * lucide-react 1.0 removed every brand icon, `Github` included. This is lucide's own
 * 0.577.0 GitHub glyph (ISC), drawn with the same stroke attributes as the lucide icons
 * beside it so the button keeps its look.
 */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

type Phase = 'idle' | 'starting' | 'awaiting' | 'installed' | 'error';

/**
 * One-click "Connect GitHub" via the OAuth device flow. On authorization, the server
 * installs the upstream-sync workflow into the repo (the file Vercel's clone strips).
 * No PAT, no env config — the public client id is baked into the app.
 */
export default function ConnectGitHubButton() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [userCode, setUserCode] = useState('');
  const [verificationUri, setVerificationUri] = useState('https://github.com/login/device');
  const [error, setError] = useState('');

  // Cancel any in-flight polling when the component unmounts.
  const activeRef = useRef(false);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const poll = useCallback(async (intervalMs: number) => {
    if (!activeRef.current) return;
    const result = await pollGithubConnect();
    if (!activeRef.current) return;

    if (result.status === 'installed') {
      setPhase('installed');
      // Re-render the dashboard so the onboarding step picks up the now-active workflow
      // (the step then flips to done and this control is replaced).
      router.refresh();
      return;
    }
    if (result.status === 'error') {
      setError(result.error);
      setPhase('error');
      return;
    }
    // pending — back off a little on slow_down, then poll again.
    const next = result.slowDown ? intervalMs + 5000 : intervalMs;
    setTimeout(() => void poll(next), next);
  }, [router]);

  const connect = useCallback(async () => {
    setError('');
    setPhase('starting');
    const res = await startGithubConnect();
    if (!activeRef.current) return;
    if (!res.ok || !res.userCode) {
      setError(res.error ?? 'Could not start GitHub connect.');
      setPhase('error');
      return;
    }
    setUserCode(res.userCode);
    if (res.verificationUri) setVerificationUri(res.verificationUri);
    setPhase('awaiting');
    const intervalMs = Math.max((res.interval ?? 5) + 1, 5) * 1000;
    setTimeout(() => void poll(intervalMs), intervalMs);
  }, [poll]);

  if (phase === 'installed') {
    return (
      <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
        <Check className="h-4 w-4" />
        Connected — workflow installed
      </div>
    );
  }

  if (phase === 'awaiting') {
    return (
      <div className="flex flex-col items-end gap-1.5 text-right">
        <Button asChild size="sm" variant="outline">
          <a href={verificationUri} target="_blank" rel="noopener noreferrer">
            Authorize on GitHub
            <ExternalLink className="ml-1 h-3.5 w-3.5" />
          </a>
        </Button>
        <p className="text-xs text-muted-foreground">
          Enter code{' '}
          <span className="font-mono font-semibold tracking-wider text-foreground">{userCode}</span>
        </p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Waiting for authorization…
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        onClick={() => void connect()}
        disabled={phase === 'starting'}
        className="shrink-0"
      >
        {phase === 'starting' ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <GithubMark className="mr-1 h-3.5 w-3.5" />
        )}
        {phase === 'starting' ? 'Starting…' : 'Connect GitHub'}
      </Button>
      {phase === 'error' && (
        <p className="max-w-[16rem] text-right text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
