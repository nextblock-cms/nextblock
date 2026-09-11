// app/cms/settings/security/page.tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@nextblock-cms/ui';
import { getSecurityPanelData } from './actions';
import SecurityPanel from './components/SecurityPanel';

export default async function SecuritySettingsPage() {
  // The sandbox/demo runs on a single shared account, so per-account security (2FA,
  // trusted devices, policy) is intentionally disabled there.
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    return (
      <div className="max-w-4xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle>Security &amp; 2FA</CardTitle>
            <CardDescription>
              Security settings are disabled in the sandbox/demo environment, which runs on a
              shared account and resets every 15 minutes. They are available in a real installation.
            </CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
      </div>
    );
  }

  const data = await getSecurityPanelData();

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <SecurityPanel data={data} />
    </div>
  );
}
