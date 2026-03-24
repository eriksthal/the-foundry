import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";

export function buildSignInUrl(returnBackUrl = "/") {
  const params = new URLSearchParams({ redirect_url: returnBackUrl });
  return `/sign-in?${params.toString()}`;
}

export function buildSignUpUrl(returnBackUrl = "/") {
  const params = new URLSearchParams({ redirect_url: returnBackUrl });
  return `/sign-up?${params.toString()}`;
}

export async function requireUser(returnBackUrl = "/") {
  const session = await auth();

  if (!session.userId) {
    redirect(buildSignInUrl(returnBackUrl));
  }

  return session;
}

export async function requireApiUser() {
  const session = await auth();

  if (!session.userId) {
    return null;
  }

  return session;
}

export function unauthorizedJson() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
