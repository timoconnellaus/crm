import { Button } from "@relationship-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@relationship-os/ui/components/card";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { authClient } from "../lib/auth-client.ts";
import { getSession, getSignInMethods } from "../server/session.public.ts";

interface SignInSearch {
  redirect?: string;
}

function safeRedirect(target: string | undefined): string {
  // Only same-origin paths: never an open redirect.
  return target?.startsWith("/") && !target.startsWith("//") ? target : "/";
}

export const Route = createFileRoute("/sign-in")({
  validateSearch: (search: Record<string, unknown>): SignInSearch =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  beforeLoad: async ({ search }) => {
    if ((await getSession()).principal) throw redirect({ href: safeRedirect(search.redirect) });
  },
  loader: () => getSignInMethods(),
  component: SignInPage,
});

function SignInPage() {
  const methods = Route.useLoaderData();
  const { redirect: target } = Route.useSearch();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Until React hydrates, a click would submit the form natively; keep it disabled until then.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const callbackURL = safeRedirect(target);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    const { error } = methods.firstAccount
      ? await authClient.signUp.email({ name: String(form.get("name")), email, password })
      : await authClient.signIn.email({ email, password });
    setPending(false);
    if (error) {
      setError(error.message ?? (methods.firstAccount ? "Sign-up failed" : "Sign-in failed"));
      return;
    }
    // A full navigation so the server sees the new session cookie on the first request.
    window.location.assign(callbackURL);
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            {methods.firstAccount ? "Create the first account" : "Sign in to Relationship OS"}
          </CardTitle>
          <CardDescription>
            {methods.firstAccount
              ? "This deployment has no users yet. The first account is its admin."
              : methods.kind === "better-auth"
                ? "Use your email and password."
                : "This deployment signs you in with Cloudflare Access."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {methods.email && (
            <form className="grid gap-3" method="post" onSubmit={onSubmit}>
              {methods.firstAccount && (
                <div className="grid gap-1.5">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" name="name" autoComplete="name" required />
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" autoComplete="email" required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={methods.firstAccount ? "new-password" : "current-password"}
                  minLength={methods.firstAccount ? 8 : undefined}
                  required
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={!hydrated || pending}>
                {methods.firstAccount
                  ? pending
                    ? "Creating account…"
                    : "Create account"
                  : pending
                    ? "Signing in…"
                    : "Sign in"}
              </Button>
            </form>
          )}
          {methods.google && (
            <Button
              variant="outline"
              disabled={!hydrated}
              onClick={() => authClient.signIn.social({ provider: "google", callbackURL })}
            >
              Continue with Google
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
