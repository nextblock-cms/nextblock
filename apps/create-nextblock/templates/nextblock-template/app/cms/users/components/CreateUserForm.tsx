// app/cms/users/components/CreateUserForm.tsx
"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@nextblock-cms/ui";
import { Input } from "@nextblock-cms/ui";
import { Label } from "@nextblock-cms/ui";
import { Checkbox } from "@nextblock-cms/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@nextblock-cms/ui";
import { Alert, AlertTitle, AlertDescription, Spinner } from "@nextblock-cms/ui";
import { Eye, EyeOff, RefreshCw } from "lucide-react";
import type { Database } from "@nextblock-cms/db";
import { createUser } from "../actions";
import { USERS_LOCKED_IN_SANDBOX, USERS_SANDBOX_NOTE_CLASS, USERS_SANDBOX_NOTE_ID } from "../sandbox-lock";

// `RTL` (Affiliates partner, migration 02029) is not in the generated enum type yet.
type UserRole = Database["public"]["Enums"]["user_role"] | "RTL";

function generatePassword(length = 16): string {
  const charset =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += charset[values[i] % charset.length];
  }
  return result;
}

export default function CreateUserForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<UserRole>("USER");
  const [emailConfirm, setEmailConfirm] = useState(true);
  const [showPassword, setShowPassword] = useState(false);

  // Only errors surface here — the action redirects on success.
  const [formError, setFormError] = useState<string | null>(null);

  // The public sandbox shares every account with every visitor, so createUser refuses there: the
  // submit renders disabled beside the reason. Read inline, as SandboxCredentialsAlert does.
  const sandboxLocked = process.env.NEXT_PUBLIC_IS_SANDBOX === "true";

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setFormError("Enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setFormError("Password must be at least 8 characters.");
      return;
    }

    const formData = new FormData();
    formData.set("email", email);
    formData.set("password", password);
    formData.set("full_name", fullName);
    formData.set("role", role);
    formData.set("email_confirm", emailConfirm ? "true" : "false");

    startTransition(async () => {
      try {
        const result = await createUser(formData);
        // On success the action redirects; only errors return here.
        if (result?.error) {
          setFormError(result.error);
        }
      } catch {
        setFormError("Something went wrong creating the user. Please try again.");
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {sandboxLocked && (
        <p id={USERS_SANDBOX_NOTE_ID} className={USERS_SANDBOX_NOTE_CLASS}>
          {USERS_LOCKED_IN_SANDBOX}
        </p>
      )}
      {formError && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <div>
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="off"
          className="mt-1"
          placeholder="user@example.com"
        />
      </div>

      <div>
        <Label htmlFor="full_name">Full Name</Label>
        <Input
          id="full_name"
          name="full_name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          className="mt-1"
          placeholder="Jane Doe"
        />
        <p className="text-xs text-muted-foreground mt-1">Optional. Can be edited later.</p>
      </div>

      <div>
        <Label htmlFor="password">Password</Label>
        <div className="flex gap-2 mt-1">
          <div className="relative flex-1">
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="pr-10"
              placeholder="At least 8 characters"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setPassword(generatePassword());
              setShowPassword(true);
            }}
          >
            <RefreshCw className="mr-2 h-4 w-4" /> Generate
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Share this password with the user securely. They can change it later from their profile.
        </p>
      </div>

      <div>
        <Label htmlFor="role">Role</Label>
        <Select value={role} onValueChange={(val: UserRole) => setRole(val)}>
          <SelectTrigger id="role" className="mt-1">
            <SelectValue placeholder="Select role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="USER">User</SelectItem>
            <SelectItem value="RTL">Partner (RTL)</SelectItem>
            <SelectItem value="WRITER">Writer</SelectItem>
            <SelectItem value="ADMIN">Admin</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          Writers and Admins can access the CMS. Users have public-site access only. Partners
          (RTL) use the partner portal once they have joined the program at /partners.
        </p>
      </div>

      <div className="flex items-start space-x-2 pt-2">
        <Checkbox
          id="email_confirm"
          checked={emailConfirm}
          onCheckedChange={(checked) => setEmailConfirm(checked as boolean)}
          className="mt-0.5"
        />
        <div>
          <Label htmlFor="email_confirm" className="font-normal leading-none">
            Mark email as confirmed
          </Label>
          <p className="text-xs text-muted-foreground mt-1">
            The user can sign in immediately without a verification email. Uncheck only if your
            project sends confirmation emails and you want the user to verify first.
          </p>
        </div>
      </div>

      <div className="flex justify-end space-x-3 pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push("/cms/users")}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={isPending || sandboxLocked}
          aria-describedby={sandboxLocked ? USERS_SANDBOX_NOTE_ID : undefined}
        >
          {isPending ? (
            <>
              <Spinner className="mr-2 h-4 w-4" /> Creating...
            </>
          ) : (
            "Create User"
          )}
        </Button>
      </div>
    </form>
  );
}
