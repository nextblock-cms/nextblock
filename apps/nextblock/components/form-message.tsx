 'use client';

import { useTranslations } from "@nextblock-cms/utils";

export type Message =
  | { success: string }
  | { error: string }
  | { message: string };

export function FormMessage({ message }: { message?: Message }) {
  const { t } = useTranslations();

  if (!message) return null;

  return (
    <div className="flex flex-col gap-2 w-full max-w-md text-sm">
      {"success" in message && message.success && (
        <div role="status" className="text-foreground border-l-2 border-foreground px-4">
          {t(message.success)}
        </div>
      )}
      {"error" in message && message.error && (
        <div role="alert" className="text-destructive border-l-2 border-destructive px-4">
          {t(message.error)}
        </div>
      )}
      {"message" in message && message.message && (
        <div role="status" className="text-foreground border-l-2 px-4">{t(message.message)}</div>
      )}
    </div>
  );
}
