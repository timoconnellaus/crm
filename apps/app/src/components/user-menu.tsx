import type { Principal } from "@relationship-os/auth";
import { Avatar, AvatarFallback } from "@relationship-os/ui/components/avatar";
import { Button } from "@relationship-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@relationship-os/ui/components/dropdown-menu";
import { LogOut, SunMoon } from "lucide-react";
import { authClient } from "../lib/auth-client.ts";
import { type Theme, useTheme } from "./theme.tsx";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function UserMenu({
  principal,
  signOutUrl,
}: {
  principal: Principal;
  /** Set when sign-out is a plain URL (Cloudflare Access); otherwise Better Auth's API is used. */
  signOutUrl: string | null;
}) {
  const { theme, setTheme } = useTheme();

  async function signOut() {
    if (signOutUrl) {
      window.location.assign(signOutUrl);
      return;
    }
    await authClient.signOut();
    window.location.assign("/sign-in");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="gap-2 px-2" data-testid="user-menu">
          <Avatar className="size-7">
            <AvatarFallback>{initials(principal.name) || "?"}</AvatarFallback>
          </Avatar>
          <span className="hidden text-sm sm:inline">{principal.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="grid">
          <span>{principal.name}</span>
          <span className="text-xs font-normal text-muted-foreground">{principal.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <SunMoon />
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
