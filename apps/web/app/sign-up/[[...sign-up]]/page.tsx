import { SignUp } from "@clerk/nextjs";
import { redirect } from "next/navigation";

import { auth } from "@clerk/nextjs/server";
import { buildSignInUrl } from "../../../lib/auth";

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string }>;
}) {
  const { userId } = await auth();
  const { redirect_url: redirectUrl = "/" } = await searchParams;

  if (userId) {
    redirect(redirectUrl);
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <SignUp
        fallbackRedirectUrl={redirectUrl}
        signInUrl={buildSignInUrl(redirectUrl)}
      />
    </div>
  );
}
