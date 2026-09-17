'use client';

import React from "react";
import { forgotPasswordAction } from "../../actions";
import { FormMessage, Message } from "../../../components/form-message";
import { SubmitButton } from "../../../components/submit-button";
import { Input } from "@nextblock-cms/ui";
import { Label } from "@nextblock-cms/ui";
import Link from "next/link";
import { useTranslations } from "@nextblock-cms/utils";
import { useSearchParams } from "next/navigation";

function getMessage(searchParams: URLSearchParams): Message | undefined {
    if (searchParams.has('error')) {
        const error = searchParams.get('error');
        if (error) return { error };
    }
    if (searchParams.has('success')) {
        const success = searchParams.get('success');
        if (success) return { success };
    }
    if (searchParams.has('message')) {
        const message = searchParams.get('message');
        if (message) return { message };
    }
    return undefined;
}

export default function ForgotPassword() {
  const { t } = useTranslations();
  const searchParams = useSearchParams();
  const formMessage = getMessage(searchParams);

  return (
    <>
      <form className="flex-1 flex flex-col w-full gap-2 text-foreground [&>input]:mb-6 min-w-64 max-w-64 mx-auto">
        <div>
          <h1 className="text-2xl font-medium">{t('reset_password')}</h1>
          <p className="text-sm text-secondary-foreground">
            {t('already_have_account')}{" "}
            <Link className="text-primary underline transition-colors hover:text-primary/80" href="/sign-in">
              {t('sign_in')}
            </Link>
          </p>
        </div>
        <div className="flex flex-col gap-2 [&>input]:mb-3 mt-8">
          <Label htmlFor="email">{t('email')}</Label>
          <Input
            id="email"
            type="email"
            name="email"
            autoComplete="email"
            spellCheck={false}
            placeholder={t('you_at_example_com')}
            required
          />
          <SubmitButton formAction={forgotPasswordAction}>
            {t('reset_password')}
          </SubmitButton>
          <FormMessage message={formMessage} />
        </div>
      </form>
    </>
  );
}
