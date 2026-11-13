import { Suspense } from "react";
import { shouldShowSandboxDemoPartner } from "../../../lib/affiliates/sandbox-demo-partner";
import SignInForm from "./SignInForm";

// Per-request render, like /sign-up: on the sandbox the banner lists the demo partner only while
// the Affiliates package is active there, which is read at request time.
export const dynamic = 'force-dynamic';

// Server wrapper: resolves what the sandbox banner may advertise, then hands it to the
// interactive client form (useSearchParams stays inside the Suspense boundary).
export default async function SignInPage() {
  const showDemoPartner = await shouldShowSandboxDemoPartner();

  return (
    <Suspense fallback={null}>
      <SignInForm showDemoPartner={showDemoPartner} />
    </Suspense>
  );
}
