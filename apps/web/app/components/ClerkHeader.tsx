"use client";
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { usePathname } from "next/navigation";

export default function ClerkHeader() {
  const pathname = usePathname();
  const currentUrl = pathname || "/";

  return (
    <div className="flex items-center gap-4">
      <Show when="signed-out">
        <SignInButton mode="redirect" forceRedirectUrl={currentUrl} signUpForceRedirectUrl={currentUrl} fallbackRedirectUrl={currentUrl}>
          <button className="text-sm text-zinc-400 hover:text-zinc-100">Sign in</button>
        </SignInButton>
        <SignUpButton mode="redirect" forceRedirectUrl={currentUrl} signInForceRedirectUrl={currentUrl} fallbackRedirectUrl={currentUrl}>
          <button className="text-sm text-zinc-400 hover:text-zinc-100">Sign up</button>
        </SignUpButton>
      </Show>
      <Show when="signed-in">
        <UserButton />
      </Show>
    </div>
  );
}
