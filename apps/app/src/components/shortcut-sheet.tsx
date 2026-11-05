// The `?` keyboard shortcut sheet.
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@relationship-os/ui/components/dialog";
import { Kbd, KbdGroup } from "@relationship-os/ui/components/kbd";
import { SHORTCUTS } from "#/lib/shortcuts";

export function ShortcutSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Single-key shortcuts pause while you type in a field.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {SHORTCUTS.map((group) => (
            <section key={group.title} aria-labelledby={`shortcuts-${group.title}`}>
              <h3
                id={`shortcuts-${group.title}`}
                className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
              >
                {group.title}
              </h3>
              <dl className="grid gap-2">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.label}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <dt>{shortcut.label}</dt>
                    <dd>
                      <KbdGroup>
                        {shortcut.keys.map((key) => (
                          <Kbd key={key}>{key}</Kbd>
                        ))}
                      </KbdGroup>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
