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
import { ScrollArea } from "@/components/ui/scroll-area";

const DEFAULT_THEME = "tokyonight-night";
const PDF_WORKER_SRC = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;

type TocItem = {
  title: string;
  page: number | null;
  items: TocItem[];
};

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
  const [tocOpen, setTocOpen] = useState(false);
  const [tocItems, setTocItems] = useState<TocItem[]>([]);
  const [tocLoading, setTocLoading] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(0.6);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const renderIdRef = useRef(0);
  const lastDocUrlRef = useRef<string | null>(null);

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
    const scrollContainer = scrollRef.current;
    const renderId = renderIdRef.current + 1;
    renderIdRef.current = renderId;
    const isNewDoc = activeDocUrl !== lastDocUrlRef.current;
    lastDocUrlRef.current = activeDocUrl;

    if (isNewDoc) {
      setPdfLoading(true);
      setTocItems([]);
      setTocLoading(true);
    }
    setPdfError(null);

    let scrollAnchor: { page: number; offset: number } | null = null;

    if (!isNewDoc && scrollContainer && container) {
      const canvases = Array.from(
        container.querySelectorAll("canvas[data-page]"),
      ) as HTMLCanvasElement[];
      const scrollTop = scrollContainer.scrollTop;

      for (const canvas of canvases) {
        const pageNumber = Number(canvas.dataset.page);
        if (!Number.isFinite(pageNumber)) {
          continue;
        }

        const rect = canvas.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();

        if (rect.bottom >= containerRect.top) {
          const offset = Math.max(0, scrollTop - canvas.offsetTop);
          scrollAnchor = { page: pageNumber, offset };
          break;
        }
      }
    }

    if (isNewDoc && container) {
      container.innerHTML = "";
    }

    if (isNewDoc && scrollContainer) {
      scrollContainer.scrollTop = 0;
    }

    let cancelled = false;
    let observer: IntersectionObserver | null = null;

    const renderPdf = async () => {
      try {
        const loadingTask = getDocument(activeDocUrl);
        const pdf = await loadingTask.promise;

        if (cancelled || renderIdRef.current !== renderId) {
          return;
        }

        if (isNewDoc) {
          const resolveOutline = async () => {
            const resolveDestination = async (dest: unknown) => {
              if (!dest) {
                return null;
              }

              let destination: unknown = dest;
              if (typeof destination === "string") {
                destination = await pdf.getDestination(destination);
              }

              if (!Array.isArray(destination) || destination.length === 0) {
                return null;
              }

              const pageRef = destination[0];
              if (typeof pageRef === "number") {
                return pageRef + 1;
              }

              try {
                const pageIndex = await pdf.getPageIndex(pageRef);
                return pageIndex + 1;
              } catch (error) {
                return null;
              }
            };

            const resolveOutlineItem = async (item: {
              title?: string;
              dest?: unknown;
              items?: unknown[];
            }): Promise<TocItem> => {
              const page = await resolveDestination(item.dest);
              const children = Array.isArray(item.items)
                ? await Promise.all(
                    item.items.map((child) =>
                      resolveOutlineItem(child as typeof item),
                    ),
                  )
                : [];

              return {
                title: item.title || "Untitled",
                page,
                items: children,
              };
            };

            try {
              const outline = await pdf.getOutline();
              if (cancelled || renderIdRef.current !== renderId) {
                return;
              }

              const resolvedOutline = outline
                ? await Promise.all(outline.map(resolveOutlineItem))
                : [];

              if (!cancelled && renderIdRef.current === renderId) {
                setTocItems(resolvedOutline);
                setTocLoading(false);
              }
            } catch (error) {
              if (!cancelled && renderIdRef.current === renderId) {
                setTocItems([]);
                setTocLoading(false);
              }
            }
          };

          void resolveOutline();
        }

        const containerWidth =
          container?.clientWidth || document.documentElement.clientWidth;
        const themeBackground = resolveThemeColor("--background");
        const themeForeground = resolveThemeColor("--foreground");

        const firstPage = await pdf.getPage(1);
        const baseViewport = firstPage.getViewport({ scale: 1 });
        const baseScale =
          (containerWidth / baseViewport.width) * zoomLevel;
        const scaledViewport = firstPage.getViewport({ scale: baseScale });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        const baseCssWidth = Math.floor(scaledViewport.width);
        const baseCssHeight = Math.floor(scaledViewport.height);

        const existingCanvases = container
          ? (Array.from(
              container.querySelectorAll("canvas[data-page]"),
            ) as HTMLCanvasElement[])
          : [];
        const shouldRebuild =
          isNewDoc || !container || existingCanvases.length !== pdf.numPages;

        if (container) {
          if (shouldRebuild) {
            container.innerHTML = "";
            const fragment = document.createDocumentFragment();

            for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
              const canvas = document.createElement("canvas");
              canvas.dataset.page = String(pageNumber);
              canvas.className = "mx-auto block bg-card text-foreground";
              canvas.style.width = `${baseCssWidth}px`;
              canvas.style.height = `${baseCssHeight}px`;
              canvas.width = Math.floor(baseCssWidth * outputScale);
              canvas.height = Math.floor(baseCssHeight * outputScale);
              canvas.style.opacity = "0";
              canvas.style.transition = "opacity 120ms ease";

              const placeholderContext = canvas.getContext("2d");
              if (placeholderContext) {
                placeholderContext.fillStyle = `rgb(${themeBackground.r}, ${themeBackground.g}, ${themeBackground.b})`;
                placeholderContext.fillRect(0, 0, canvas.width, canvas.height);
              }

              fragment.appendChild(canvas);
            }

            container.appendChild(fragment);
          } else {
            existingCanvases.forEach((canvas, index) => {
              const pageNumber = Number(canvas.dataset.page) || index + 1;
              canvas.dataset.page = String(pageNumber);
              canvas.style.width = `${baseCssWidth}px`;
              canvas.style.height = `${baseCssHeight}px`;
            });
          }

          if (scrollAnchor && scrollContainer) {
            requestAnimationFrame(() => {
              const anchorCanvas = container.querySelector(
                `canvas[data-page="${scrollAnchor?.page}"]`,
              ) as HTMLCanvasElement | null;
              if (anchorCanvas) {
                scrollContainer.scrollTop =
                  anchorCanvas.offsetTop + scrollAnchor.offset;
              }
            });
          }
        }

        let hasRendered = false;
        const renderedPages = new Set<number>();
        const queuedPages = new Set<number>();
        const queue: number[] = [];
        let isRendering = false;

        const renderPage = async (pageNumber: number) => {
          if (cancelled || renderIdRef.current !== renderId) {
            return;
          }

          if (renderedPages.has(pageNumber)) {
            return;
          }

          const canvas = container?.querySelector(
            `canvas[data-page="${pageNumber}"]`,
          ) as HTMLCanvasElement | null;

          if (!canvas) {
            return;
          }

          const page = pageNumber === 1 ? firstPage : await pdf.getPage(pageNumber);

          if (cancelled || renderIdRef.current !== renderId) {
            return;
          }

          const unscaledViewport = page.getViewport({ scale: 1 });
          const scale =
            (containerWidth / unscaledViewport.width) * zoomLevel;
          const viewport = page.getViewport({ scale });
          const cssWidth = Math.floor(viewport.width);
          const cssHeight = Math.floor(viewport.height);
          const renderScale = Math.min(window.devicePixelRatio || 1, 2);
          const targetWidth = Math.floor(cssWidth * renderScale);
          const targetHeight = Math.floor(cssHeight * renderScale);

          const offscreen = document.createElement("canvas");
          offscreen.width = targetWidth;
          offscreen.height = targetHeight;
          const offscreenContext = offscreen.getContext("2d", {
            willReadFrequently: true,
          });

          if (!offscreenContext) {
            return;
          }

          offscreenContext.setTransform(1, 0, 0, 1, 0, 0);
          offscreenContext.fillStyle = `rgb(${themeBackground.r}, ${themeBackground.g}, ${themeBackground.b})`;
          offscreenContext.fillRect(0, 0, offscreen.width, offscreen.height);

          const transform =
            renderScale !== 1
              ? [renderScale, 0, 0, renderScale, 0, 0]
              : undefined;

          await page.render({
            canvasContext: offscreenContext,
            viewport,
            transform,
          }).promise;

          const imageData = offscreenContext.getImageData(
            0,
            0,
            offscreen.width,
            offscreen.height,
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

          offscreenContext.putImageData(imageData, 0, 0);
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          canvas.style.width = `${cssWidth}px`;
          canvas.style.height = `${cssHeight}px`;

          const context = canvas.getContext("2d");
          if (context) {
            context.drawImage(offscreen, 0, 0);
          }
          canvas.style.opacity = "1";
          renderedPages.add(pageNumber);

          if (!hasRendered && !cancelled) {
            hasRendered = true;
            setPdfLoading(false);
          }
        };

        const processQueue = async () => {
          if (isRendering) {
            return;
          }

          isRendering = true;

          while (queue.length > 0) {
            const nextPage = queue.shift();
            if (nextPage === undefined) {
              continue;
            }

            queuedPages.delete(nextPage);

            try {
              await renderPage(nextPage);
            } catch (error) {
              if (!cancelled) {
                setPdfError("Unable to load the PDF.");
                setPdfLoading(false);
              }
            }

            if (cancelled || renderIdRef.current !== renderId) {
              break;
            }
          }

          isRendering = false;
        };

        const enqueue = (pageNumber: number, priority: "normal" | "high" = "normal") => {
          if (renderedPages.has(pageNumber) || queuedPages.has(pageNumber)) {
            return;
          }

          queuedPages.add(pageNumber);
          if (priority === "high") {
            queue.unshift(pageNumber);
          } else {
            queue.push(pageNumber);
          }
          void processQueue();
        };

        if (pdf.numPages === 0) {
          setPdfLoading(false);
          return;
        }

        enqueue(1);

        observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) {
                continue;
              }

              const target = entry.target as HTMLElement;
              const pageNumber = Number(target.dataset.page);
              if (Number.isFinite(pageNumber)) {
                enqueue(pageNumber, "high");
              }
            }
          },
          {
            root: scrollContainer || null,
            rootMargin: "800px 0px",
            threshold: 0.1,
          },
        );

        container
          ?.querySelectorAll("canvas[data-page]")
          .forEach((canvas) => observer?.observe(canvas));
      } catch (error) {
        if (!cancelled) {
          setPdfError("Unable to load the PDF.");
          setPdfLoading(false);
          if (isNewDoc) {
            setTocItems([]);
            setTocLoading(false);
          }
        }
      }
    };

    renderPdf();

    return () => {
      cancelled = true;
      if (observer) {
        observer.disconnect();
      }
    };
  }, [activeDocUrl, zoomLevel]);

  const scrollToPage = (pageNumber: number) => {
    const container = viewerRef.current;
    const scrollContainer = scrollRef.current;
    if (!container || !scrollContainer) {
      return;
    }

    const target = container.querySelector(
      `canvas[data-page="${pageNumber}"]`,
    ) as HTMLCanvasElement | null;

    if (!target) {
      return;
    }

    scrollContainer.scrollTop = target.offsetTop;
  };

  const renderTocItems = (items: TocItem[], depth = 0) => {
    const listClassName = `${depth === 0 ? "space-y-3" : "space-y-1"} ${
      depth > 0 ? "pl-4" : ""
    }`;

    return (
      <ul className={listClassName}>
        {items.map((item, index) => {
          const isInteractive = item.page !== null;
          const toneByDepth =
            depth === 0
              ? "text-sm font-semibold text-primary"
              : depth === 1
                ? "text-xs font-medium text-foreground"
                : "text-xs text-muted-foreground";

          return (
            <li key={`${depth}-${index}-${item.title}`}>
              <button
                type="button"
                disabled={!isInteractive}
                onClick={() =>
                  item.page !== null ? scrollToPage(item.page) : undefined
                }
                className={`w-full text-left leading-5 transition-colors hover:bg-accent/40 ${toneByDepth} ${
                  isInteractive
                    ? "hover:text-primary"
                    : "cursor-default text-muted-foreground"
                }`}
              >
                {item.title}
              </button>
              {item.items.length > 0
                ? renderTocItems(item.items, depth + 1)
                : null}
            </li>
          );
        })}
      </ul>
    );
  };

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

      if (!activeDocUrl || commandOpen) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const isEditable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (isEditable) {
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        setTocOpen((current) => !current);
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoomLevel((current) => Math.min(4, current + 0.1));
      }

      if (event.key === "-") {
        event.preventDefault();
        setZoomLevel((current) => Math.max(0.4, current - 0.1));
      }

      if (event.key === "s") {
        event.preventDefault();
        setZoomLevel(0.8);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeDocUrl, commandOpen]);

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
        <div className="fixed inset-0 bg-background">
          <div className="flex h-full w-full">
            {tocOpen ? (
              <aside
                aria-label="Table of contents"
                className="flex h-full w-72 shrink-0 flex-col border-r border-border bg-card"
              >
                <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
                  Contents
                </div>
                <ScrollArea
                  className="flex-1"
                  type="scroll"
                  scrollHideDelay={600}
                >
                  <div className="px-3 py-2">
                    {tocLoading ? (
                      <div className="text-xs text-muted-foreground">
                        Loading...
                      </div>
                    ) : tocItems.length > 0 ? (
                      renderTocItems(tocItems)
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        No table of contents.
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </aside>
            ) : null}
            <ScrollArea
              className="relative flex-1"
              type="scroll"
              scrollHideDelay={600}
              viewportRef={scrollRef}
            >
              <div className="relative min-h-screen w-full">
                <div
                  ref={viewerRef}
                  className="pdf-viewer flex w-full flex-col items-start"
                />
                {pdfLoading ? (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
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
            </ScrollArea>
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
