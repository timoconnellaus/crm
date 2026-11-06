// A diff's lines, as the merge card and the compare page show them.
const STYLE: Record<string, string> = {
  add: "bg-green-500/10 text-green-800 dark:text-green-300",
  remove: "bg-red-500/10 text-red-800 line-through dark:text-red-300",
  same: "",
};
const SIGN: Record<string, string> = { add: "+", remove: "-", same: " " };

export function DiffLines({ lines }: { lines: readonly { kind: string; text: string }[] }) {
  if (!lines.length) return <p className="text-sm text-muted-foreground">No changes.</p>;
  return (
    <pre className="max-h-80 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines may repeat.
        <div key={i} className={STYLE[line.kind]}>
          {SIGN[line.kind]} {line.text}
        </div>
      ))}
    </pre>
  );
}
