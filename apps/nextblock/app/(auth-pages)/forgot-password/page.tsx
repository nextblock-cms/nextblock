import { notFound } from "next/navigation";
import ForgotPasswordForm from "./ForgotPasswordForm";

// The public sandbox shares its demo accounts and sends no account email (forgotPasswordAction
// refuses there and /sign-in hides the link), so this page does not exist on it, like
// /profile/password.
export default function ForgotPasswordPage() {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === "true") {
    notFound();
  }

  return <ForgotPasswordForm />;
}
