import { cn } from "@/lib/utils";

type StatusBarProps = {
  left: string;
  right: string;
  className?: string;
};

export function StatusBar({ left, right, className }: StatusBarProps) {
  return (
    <div
      role="status"
      aria-label="Document status"
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/80 backdrop-blur",
        "px-4 py-2 font-mono text-sm",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1 truncate text-foreground/80" title={left}>
          {left}
        </div>
        <div className="shrink-0 tabular-nums text-foreground/80">{right}</div>
      </div>
    </div>
  );
}
