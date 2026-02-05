import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MentionContent,
  MentionInput,
  MentionItem,
  MentionPortal,
  MentionRoot,
} from "@diceui/mention";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import Loader from "@/components/loader";

const DEFAULT_THEME = "tokyonight-night";
const PDF_WORKER_SRC = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;

const parseRgb = (value: string) => {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) {
    return { r: 255, g: 255, b: 255 };
  }
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
  };
};

const resolveThemeColor = (variable: string) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${variable})`;
  probe.style.position = "absolute";
  probe.style.opacity = "0";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  return parseRgb(color);
};

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandText, setCommandText] = useState("");
  const [activeDocUrl, setActiveDocUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const renderIdRef = useRef(0);

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
    if (!activeDocUrl) {
      return;
    }

    const container = viewerRef.current;
    const renderId = renderIdRef.current + 1;
    renderIdRef.current = renderId;
    setPdfLoading(true);
    setPdfError(null);

    if (container) {
      container.innerHTML = "";
    }

    let cancelled = false;

    const renderPdf = async () => {
      try {
        const loadingTask = getDocument(activeDocUrl);
        const pdf = await loadingTask.promise;

        const containerWidth =
          container?.clientWidth || document.documentElement.clientWidth;
        const themeBackground = resolveThemeColor("--background");
        const themeForeground = resolveThemeColor("--foreground");

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          if (cancelled || renderIdRef.current !== renderId) {
            return;
          }

          const page = await pdf.getPage(pageNumber);
          const unscaledViewport = page.getViewport({ scale: 1 });
          const scale = containerWidth / unscaledViewport.width;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d");

          if (!context || !container) {
            continue;
          }

          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.className = "w-full bg-card text-foreground";
          canvas.style.opacity = "0";
          canvas.style.transition = "opacity 120ms ease";
          container.appendChild(canvas);

          context.fillStyle = `rgb(${themeBackground.r}, ${themeBackground.g}, ${themeBackground.b})`;
          context.fillRect(0, 0, canvas.width, canvas.height);

          await page.render({ canvasContext: context, viewport }).promise;

          const imageData = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          );
          const { data } = imageData;
          const fg = themeForeground;
          const bg = themeBackground;

          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3];

            if (a === 0) {
              continue;
            }

            const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            const intensity = 1 - luminance;

            data[i] = Math.round(bg.r + (fg.r - bg.r) * intensity);
            data[i + 1] = Math.round(bg.g + (fg.g - bg.g) * intensity);
            data[i + 2] = Math.round(bg.b + (fg.b - bg.b) * intensity);
          }

          context.putImageData(imageData, 0, 0);
          canvas.style.opacity = "1";
        }

        if (!cancelled) {
          setPdfLoading(false);
        }
      } catch (error) {
        if (!cancelled) {
          setPdfError("Unable to load the PDF.");
          setPdfLoading(false);
        }
      }
    };

    renderPdf();

    return () => {
      cancelled = true;
    };
  }, [activeDocUrl]);

  useEffect(() => {
    if (!commandOpen) {
      return;
    }

    if (!commandText) {
      setCommandText(":");
    }

    const focusInput = () => inputRef.current?.focus();
    const timer = requestAnimationFrame(focusInput);

    return () => cancelAnimationFrame(timer);
  }, [commandOpen, commandText]);

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

  const commandValue = commandOpen && !commandText ? ":" : commandText;

  const handleCommandSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = commandValue.trim().replace(/^:/, "").trim();

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
        <div className="fixed inset-0 overflow-auto bg-background">
          <div className="min-h-screen w-full">
            <div
              ref={viewerRef}
              className="pdf-viewer flex w-full flex-col"
            />
            {pdfLoading ? (
              <div className="pointer-events-none fixed inset-0 z-10 flex items-center justify-center">
                <div className="text-primary">
                  <Loader />
                </div>
              </div>
            ) : null}
            {pdfError ? (
              <div className="mt-6 text-sm text-destructive">
                {pdfError}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {commandOpen ? (
        <div className="fixed inset-x-0 bottom-0 z-50 px-4 pb-6">
          <div className="mx-auto w-full max-w-3xl border border-border bg-card/90 p-3 shadow-lg backdrop-blur">
              <MentionRoot
                trigger=":"
                inputValue={commandValue}
                onInputValueChange={setCommandText}
              >
              <form onSubmit={handleCommandSubmit}>
                <MentionInput
                  ref={inputRef}
                  value={commandValue}
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
