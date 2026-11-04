// A link to an app path known only at run time (a record of any object, a notification's href):
// a real <a href> (open in new tab works) that navigates client-side on a plain click.
import { useRouter } from "@tanstack/react-router";
import type { ComponentProps, MouseEvent } from "react";

export function HrefLink({ href, onClick, ...props }: ComponentProps<"a"> & { href: string }) {
  const router = useRouter();
  return (
    <a
      {...props}
      href={href}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        void router.navigate({ href });
      }}
    />
  );
}
