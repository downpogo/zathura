import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MentionContent,
  MentionInput,
  MentionItem,
  MentionPortal,
  MentionRoot,
} from "@diceui/mention";

const DEFAULT_THEME = "tokyonight-night";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandText, setCommandText] = useState("");
  const [activeDocUrl, setActiveDocUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const commandDefinitions = useMemo(
    () => [
      {
        name: "open",
        signature: "open <url>",
        description: "Open a PDF by URL",
        run: (args: string) => {
          const url = args.trim();
          if (!url) {
            return { ok: false };
          }

          setActiveDocUrl(url);
          return { ok: true };
        },
      },
    ],
    [],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = DEFAULT_THEME;
  }, []);

  useEffect(() => {
    if (!commandOpen) {
      return;
    }

    const focusInput = () => inputRef.current?.focus();
    const timer = requestAnimationFrame(focusInput);

    return () => cancelAnimationFrame(timer);
  }, [commandOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === ":") {
        const target = event.target as HTMLElement | null;
        const isEditable =
          target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          target?.isContentEditable;

        if (isEditable) {
          return;
        }

        event.preventDefault();
        setCommandOpen(true);
        setCommandText(":");
      }

      if (event.key === "Escape" && commandOpen) {
        event.preventDefault();
        setCommandOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandOpen]);

  const handleCommandSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = commandText.trim().replace(/^:/, "").trim();

    if (!input) {
      return;
    }

    const [name, ...rest] = input.split(/\s+/);
    const args = rest.join(" ");
    const definition = commandDefinitions.find(
      (command) => command.name === name,
    );

    if (!definition) {
      return;
    }

    const result = definition.run(args);

    if (result.ok) {
      setCommandOpen(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {activeDocUrl ? (
        <iframe
          className="h-screen w-full"
          src={activeDocUrl}
          title="PDF Viewer"
        />
      ) : null}

      {commandOpen ? (
        <div className="fixed inset-x-0 bottom-0 z-50 px-4 pb-6">
          <div className="mx-auto w-full max-w-3xl border border-border bg-card/90 p-3 shadow-lg backdrop-blur">
            <MentionRoot
              trigger=":"
              inputValue={commandText}
              onInputValueChange={setCommandText}
            >
              <form onSubmit={handleCommandSubmit}>
                <MentionInput
                  ref={inputRef}
                  className="w-full border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary"
                />
              </form>
              <MentionPortal>
                <MentionContent className="z-50 mt-2 w-56 border border-border bg-card p-1 text-xs text-foreground shadow-lg">
                  {commandDefinitions.map((command) => (
                    <MentionItem
                      key={command.name}
                      value={command.name}
                      className="cursor-default px-2 py-1 text-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                    >
                      {command.signature}
                    </MentionItem>
                  ))}
                </MentionContent>
              </MentionPortal>
            </MentionRoot>
          </div>
        </div>
      ) : null}
    </div>
  );
}
