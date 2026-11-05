// Markdown rendering (react-markdown: no raw HTML, so user text cannot inject markup) and a
// Write/Preview editor for Markdown fields such as a person's description.
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@relationship-os/ui/components/tabs";
import { Textarea } from "@relationship-os/ui/components/textarea";
import { cn } from "@relationship-os/ui/lib/utils";
import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";

const PROSE =
  "text-sm leading-relaxed break-words [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0";

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn(PROSE, className)} data-testid="markdown">
      <ReactMarkdown
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export interface MarkdownEditorProps
  extends Omit<ComponentProps<typeof Textarea>, "value" | "onChange"> {
  value: string;
  onChange: (value: string) => void;
  /** Accessible label of the text area. */
  label: string;
}

export function MarkdownEditor({
  value,
  onChange,
  label,
  className,
  ...props
}: MarkdownEditorProps) {
  return (
    <Tabs defaultValue="write" className="gap-2">
      <TabsList className="h-8">
        <TabsTrigger value="write" className="text-xs">
          Write
        </TabsTrigger>
        <TabsTrigger value="preview" className="text-xs">
          Preview
        </TabsTrigger>
      </TabsList>
      <TabsContent value="write" className="mt-0">
        <Textarea
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn("min-h-28 font-mono text-sm", className)}
          {...props}
        />
        <p className="mt-1 text-xs text-muted-foreground">Markdown is supported.</p>
      </TabsContent>
      <TabsContent value="preview" className="mt-0 min-h-28 rounded-md border p-3">
        {value.trim() ? (
          <Markdown>{value}</Markdown>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing to preview.</p>
        )}
      </TabsContent>
    </Tabs>
  );
}
