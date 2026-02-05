import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MentionContent,
  MentionInput,
  MentionItem,
  MentionRoot,
} from "@diceui/mention";
import { useHotkeys } from "react-hotkeys-hook";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { toast } from "sonner";
import Loader from "@/components/loader";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

const DEFAULT_THEME = "tokyonight-night";
const THEME_STORAGE_KEY = "zathura.theme";
const RECENT_STORAGE_KEY = "zathura.recent";
const DOC_STORAGE_PREFIX = "zathura.doc.";
const RECENT_DOC_LIMIT = 10;
const SCROLL_STEP_PX = 40;
const THEMES = [
  { id: "tokyonight-night", label: "Tokyo Night" },
  { id: "catppuccin", label: "Catppuccin" },
  { id: "catppuccin-latte", label: "Catppuccin Latte" },
  { id: "ethereal", label: "Ethereal" },
  { id: "everforest", label: "Everforest" },
  { id: "flexoki-light", label: "Flexoki Light" },
  { id: "gruvbox", label: "Gruvbox" },
  { id: "hackerman", label: "Hackerman" },
  { id: "kanagawa", label: "Kanagawa" },
  { id: "matte-black", label: "Matte Black" },
  { id: "miasma", label: "Miasma" },
  { id: "nord", label: "Nord" },
  { id: "osaka-jade", label: "Osaka Jade" },
  { id: "ristretto", label: "Ristretto" },
  { id: "rose-pine", label: "Rose Pine" },
];
const THEME_IDS = new Set(THEMES.map((theme) => theme.id));
const THEME_ALIASES: Record<string, string> = {
  "tokyo-night": "tokyonight-night",
  tokyonight: "tokyonight-night",
};

const normalizeThemeInput = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/\s+/g, "-");

const resolveTheme = (value: string) => {
  const normalized = normalizeThemeInput(value);
  if (!normalized) {
    return null;
  }
  const resolved = THEME_ALIASES[normalized] ?? normalized;
  return THEME_IDS.has(resolved) ? resolved : null;
};

const getStoredTheme = () => {
  if (typeof window === "undefined") {
    return null;
  }
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored ? resolveTheme(stored) : null;
};

type TocItem = {
  title: string;
  page: number | null;
  items: TocItem[];
};

type DocSource = "url" | "file";

type DocMeta = {
  key: string;
  sourceId: string;
  label: string;
  source: DocSource;
  url: string | null;
};

type RecentDoc = {
  key: string;
  sourceId: string;
  label: string;
  source: DocSource;
  url: string | null;
  lastOpened: number;
  lastPage: number;
};

type DocState = {
  key: string;
  sourceId: string;
  label: string;
  source: DocSource;
  url: string | null;
  lastOpened: number;
  lastPage: number;
  toc: TocItem[] | null;
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

const hashString = (value: string) => {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return Math.abs(hash).toString(36);
};

const getDocStorageKey = (key: string) => `${DOC_STORAGE_PREFIX}${key}`;

const readStoredJson = <T,>(key: string): T | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const writeStoredJson = (key: string, value: unknown) => {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures.
  }
};

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandText, setCommandText] = useState("");
  const [activeTheme, setActiveTheme] = useState(() => getStoredTheme() ?? DEFAULT_THEME);
  const [activeDocUrl, setActiveDocUrl] = useState<string | null>(null);
  const [recentDocs, setRecentDocs] = useState<RecentDoc[]>([]);
  const [recentHighlightIndex, setRecentHighlightIndex] = useState(0);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [tocItems, setTocItems] = useState<TocItem[]>([]);
  const [tocLoading, setTocLoading] = useState(false);
  const [tocExpandedPaths, setTocExpandedPaths] = useState<Set<string>>(() => new Set());
  const [tocActivePath, setTocActivePath] = useState<string | null>(null);
  const [tocFoldMode, setTocFoldMode] = useState<0 | 1 | 2>(0);
  const [zoomLevel, setZoomLevel] = useState(0.6);
  const [themeHighlightIndex, setThemeHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileObjectUrlRef = useRef<string | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const renderIdRef = useRef(0);
  const lastDocUrlRef = useRef<string | null>(null);
  const lastThemeRef = useRef<string | null>(null);
  const themeListRef = useRef<HTMLDivElement | null>(null);
  const recentListRef = useRef<HTMLDivElement | null>(null);
  const tocListRef = useRef<HTMLDivElement | null>(null);
  const themeItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const recentItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const lastThemeInteractionRef = useRef<"keyboard" | "mouse" | null>(null);
  const lastRecentInteractionRef = useRef<"keyboard" | "mouse" | null>(null);
  const tocGPressTimeoutRef = useRef<number | null>(null);
  const pendingRecentDocRef = useRef<RecentDoc | null>(null);
  const activeDocStateRef = useRef<DocState | null>(null);
  const cachedTocRef = useRef<TocItem[] | null>(null);
  const pendingRestorePageRef = useRef<number | null>(null);
  const pageCanvasesRef = useRef<HTMLCanvasElement[]>([]);
  const lastRecordedPageRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);

  const closeDocument = useCallback(() => {
    setActiveDocUrl(null);
    setPdfLoading(false);
    setPdfError(null);
    setTocOpen(false);
    setTocItems([]);
    setTocLoading(false);
    activeDocStateRef.current = null;
    cachedTocRef.current = null;
    pendingRestorePageRef.current = null;
    pageCanvasesRef.current = [];
    lastRecordedPageRef.current = null;
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
  }, []);

  const loadRecentDocs = useCallback(
    () => readStoredJson<RecentDoc[]>(RECENT_STORAGE_KEY) ?? [],
    [],
  );

  const loadDocState = useCallback(
    (key: string) => readStoredJson<DocState>(getDocStorageKey(key)),
    [],
  );

  const saveDocState = useCallback((state: DocState) => {
    writeStoredJson(getDocStorageKey(state.key), state);
  }, []);

  const updateRecentDocs = useCallback((entry: RecentDoc) => {
    setRecentDocs((current) => {
      const next = [entry, ...current.filter((doc) => doc.key !== entry.key)].slice(
        0,
        RECENT_DOC_LIMIT,
      );
      writeStoredJson(RECENT_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const buildUrlLabel = (url: string) => {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const last = segments[segments.length - 1];
      return last ? decodeURIComponent(last) : parsed.hostname;
    } catch {
      return url;
    }
  };

  const buildUrlMeta = useCallback((url: string): DocMeta => {
    const sourceId = url;
    return {
      key: hashString(sourceId),
      sourceId,
      label: buildUrlLabel(url),
      source: "url",
      url,
    };
  }, []);

  const buildFileMeta = useCallback((file: File): DocMeta => {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const sourceBase = relativePath || file.name;
    const sourceId = `${sourceBase}:${file.size}:${file.lastModified}`;
    return {
      key: hashString(sourceId),
      sourceId,
      label: file.name,
      source: "file",
      url: null,
    };
  }, []);

  const openDocument = useCallback(
    (meta: DocMeta, docUrl: string) => {
      setActiveDocUrl(docUrl);
      const stored = loadDocState(meta.key);
      const lastOpened = Date.now();
      const lastPage = stored?.lastPage ?? 1;
      const toc = stored?.toc ?? null;
      const nextState: DocState = {
        key: meta.key,
        sourceId: meta.sourceId,
        label: meta.label,
        source: meta.source,
        url: meta.url,
        lastOpened,
        lastPage,
        toc,
      };
      activeDocStateRef.current = nextState;
      cachedTocRef.current = toc;
      pendingRestorePageRef.current = lastPage;
      lastRecordedPageRef.current = lastPage;
      if (toc !== null) {
        setTocItems(toc);
        setTocLoading(false);
      } else {
        setTocItems([]);
        setTocLoading(true);
      }
      updateRecentDocs({
        key: meta.key,
        sourceId: meta.sourceId,
        label: meta.label,
        source: meta.source,
        url: meta.url,
        lastOpened,
        lastPage,
      });
      saveDocState(nextState);
    },
    [loadDocState, saveDocState, updateRecentDocs],
  );

  const openUrlDocument = useCallback(
    (url: string) => {
      const meta = buildUrlMeta(url);
      openDocument(meta, url);
    },
    [buildUrlMeta, openDocument],
  );

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

          openUrlDocument(url);
          return { ok: true };
        },
      },
      {
        name: "close",
        signature: "close",
        description: "Close the current document",
        run: () => {
          closeDocument();
          return { ok: true };
        },
      },
      {
        name: "recent",
        signature: "recent",
        description: "Show recent documents",
        run: () => ({ ok: false }),
      },
      {
        name: "theme",
        signature: "theme <name>",
        description: "Switch theme",
        run: (args: string) => {
          const nextTheme = resolveTheme(args);
          if (!nextTheme) {
            return { ok: false };
          }
          setActiveTheme(nextTheme);
          return { ok: true };
        },
      },
    ],
    [closeDocument, openUrlDocument],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = activeTheme;
  }, [activeTheme]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(THEME_STORAGE_KEY, activeTheme);
  }, [activeTheme]);

  useEffect(() => {
    setRecentDocs(loadRecentDocs());
  }, [loadRecentDocs]);

  useEffect(() => {
    return () => {
      if (fileObjectUrlRef.current) {
        URL.revokeObjectURL(fileObjectUrlRef.current);
        fileObjectUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (fileObjectUrlRef.current && activeDocUrl !== fileObjectUrlRef.current) {
      URL.revokeObjectURL(fileObjectUrlRef.current);
      fileObjectUrlRef.current = null;
    }
  }, [activeDocUrl]);

  useEffect(() => {
    setTocExpandedPaths(new Set());
    setTocActivePath(null);
    setTocFoldMode(0);
  }, [activeDocUrl]);

  useEffect(() => {
    return () => {
      if (tocGPressTimeoutRef.current) {
        window.clearTimeout(tocGPressTimeoutRef.current);
        tocGPressTimeoutRef.current = null;
      }
    };
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
    const isThemeChange = activeTheme !== lastThemeRef.current;
    lastThemeRef.current = activeTheme;

    if (isNewDoc) {
      setPdfLoading(true);
      if (cachedTocRef.current !== null) {
        setTocItems(cachedTocRef.current);
        setTocLoading(false);
      } else {
        setTocItems([]);
        setTocLoading(true);
      }
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
      let pdf: Awaited<ReturnType<typeof getDocument>["promise"]>;
      try {
        const loadingTask = getDocument(activeDocUrl);
        pdf = await loadingTask.promise;
      } catch (error) {
        if (!cancelled && renderIdRef.current === renderId) {
          console.error("Failed to load document.", error);
          toast.error("Document failed to load.");
          closeDocument();
        }
        return;
      }

      try {
        if (cancelled || renderIdRef.current !== renderId) {
          return;
        }

        if (isNewDoc && cachedTocRef.current === null) {
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
              } catch {
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
                    item.items.map((child) => resolveOutlineItem(child as typeof item)),
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
                cachedTocRef.current = resolvedOutline;
                if (activeDocStateRef.current) {
                  const nextState = {
                    ...activeDocStateRef.current,
                    toc: resolvedOutline,
                  };
                  activeDocStateRef.current = nextState;
                  saveDocState(nextState);
                }
              }
            } catch {
              if (!cancelled && renderIdRef.current === renderId) {
                setTocItems([]);
                setTocLoading(false);
                cachedTocRef.current = [];
                if (activeDocStateRef.current) {
                  const nextState = {
                    ...activeDocStateRef.current,
                    toc: [],
                  };
                  activeDocStateRef.current = nextState;
                  saveDocState(nextState);
                }
              }
            }
          };

          void resolveOutline();
        } else if (isNewDoc) {
          setTocLoading(false);
        }

        const containerWidth = container?.clientWidth || document.documentElement.clientWidth;
        const themeBackground = resolveThemeColor("--background");
        const themeForeground = resolveThemeColor("--foreground");

        const firstPage = await pdf.getPage(1);
        const baseViewport = firstPage.getViewport({ scale: 1 });
        const baseScale = (containerWidth / baseViewport.width) * zoomLevel;
        const scaledViewport = firstPage.getViewport({ scale: baseScale });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        const baseCssWidth = Math.floor(scaledViewport.width);
        const baseCssHeight = Math.floor(scaledViewport.height);

        const existingCanvases = container
          ? (Array.from(container.querySelectorAll("canvas[data-page]")) as HTMLCanvasElement[])
          : [];
        const shouldRebuild =
          isNewDoc || isThemeChange || !container || existingCanvases.length !== pdf.numPages;

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
                scrollContainer.scrollTop = anchorCanvas.offsetTop + scrollAnchor.offset;
              }
            });
          }

          pageCanvasesRef.current = Array.from(
            container.querySelectorAll("canvas[data-page]"),
          ) as HTMLCanvasElement[];

          if (isNewDoc && pendingRestorePageRef.current && scrollContainer) {
            const restorePage = pendingRestorePageRef.current;
            pendingRestorePageRef.current = null;
            requestAnimationFrame(() => {
              scrollToPage(restorePage);
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
          const scale = (containerWidth / unscaledViewport.width) * zoomLevel;
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

          const transform = renderScale !== 1 ? [renderScale, 0, 0, renderScale, 0, 0] : undefined;

          await page.render({
            canvasContext: offscreenContext,
            viewport,
            transform,
          }).promise;

          const imageData = offscreenContext.getImageData(0, 0, offscreen.width, offscreen.height);
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
            } catch {
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
          console.error("Failed to render document.", error);
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
  }, [activeDocUrl, zoomLevel, activeTheme, closeDocument, saveDocState]);

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

  const getCurrentPage = useCallback(() => {
    const scrollContainer = scrollRef.current;
    const canvases = pageCanvasesRef.current;
    if (!scrollContainer || canvases.length === 0) {
      return null;
    }
    const anchor = scrollContainer.scrollTop + Math.max(1, scrollContainer.clientHeight * 0.1);
    for (const canvas of canvases) {
      const pageNumber = Number(canvas.dataset.page);
      if (!Number.isFinite(pageNumber)) {
        continue;
      }
      if (canvas.offsetTop + canvas.offsetHeight >= anchor) {
        return pageNumber;
      }
    }
    const last = canvases[canvases.length - 1];
    return last ? Number(last.dataset.page) || null : null;
  }, []);

  const updateDocProgress = useCallback(
    (pageNumber: number) => {
      if (!activeDocStateRef.current || pageNumber < 1) {
        return;
      }
      if (lastRecordedPageRef.current === pageNumber) {
        return;
      }
      lastRecordedPageRef.current = pageNumber;
      const nextState = {
        ...activeDocStateRef.current,
        lastPage: pageNumber,
      };
      activeDocStateRef.current = nextState;
      saveDocState(nextState);
      updateRecentDocs({
        key: nextState.key,
        sourceId: nextState.sourceId,
        label: nextState.label,
        source: nextState.source,
        url: nextState.url,
        lastOpened: nextState.lastOpened,
        lastPage: nextState.lastPage,
      });
    },
    [saveDocState, updateRecentDocs],
  );

  useEffect(() => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer || !activeDocUrl) {
      return undefined;
    }
    const handleScroll = () => {
      if (scrollRafRef.current) {
        return;
      }
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        const currentPage = getCurrentPage();
        if (currentPage) {
          updateDocProgress(currentPage);
        }
      });
    };
    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [activeDocUrl, getCurrentPage, updateDocProgress]);

  type TocEntry = {
    item: TocItem;
    path: string;
    depth: number;
    parentPath: string | null;
    hasChildren: boolean;
  };

  const tocIndex = useMemo(() => {
    const allEntries: TocEntry[] = [];
    const entryByPath = new Map<string, TocEntry>();
    const parentByPath = new Map<string, string | null>();
    const firstChildByPath = new Map<string, string | null>();
    const allExpandablePaths: string[] = [];
    const topLevelExpandablePaths: string[] = [];

    const walkAll = (items: TocItem[], parentPath: string | null, depth: number) => {
      items.forEach((item, index) => {
        const path = parentPath ? `${parentPath}.${index}` : `${index}`;
        const hasChildren = item.items.length > 0;
        const entry: TocEntry = {
          item,
          path,
          depth,
          parentPath,
          hasChildren,
        };
        allEntries.push(entry);
        entryByPath.set(path, entry);
        parentByPath.set(path, parentPath);
        if (hasChildren) {
          allExpandablePaths.push(path);
          if (depth === 0) {
            topLevelExpandablePaths.push(path);
          }
        }
        if (parentPath && !firstChildByPath.has(parentPath)) {
          firstChildByPath.set(parentPath, path);
        }
        if (hasChildren) {
          walkAll(item.items, path, depth + 1);
        }
      });
    };

    const visibleEntries: TocEntry[] = [];
    const walkVisible = (
      items: TocItem[],
      parentPath: string | null,
      depth: number,
      isVisible: boolean,
    ) => {
      items.forEach((item, index) => {
        const path = parentPath ? `${parentPath}.${index}` : `${index}`;
        if (isVisible) {
          const entry = entryByPath.get(path);
          if (entry) {
            visibleEntries.push(entry);
          }
        }
        const showChildren = isVisible && tocExpandedPaths.has(path);
        if (item.items.length > 0) {
          walkVisible(item.items, path, depth + 1, showChildren);
        }
      });
    };

    walkAll(tocItems, null, 0);
    walkVisible(tocItems, null, 0, true);

    return {
      visibleEntries,
      entryByPath,
      parentByPath,
      firstChildByPath,
      allExpandablePaths,
      topLevelExpandablePaths,
    };
  }, [tocItems, tocExpandedPaths]);

  useEffect(() => {
    if (!tocOpen) {
      return;
    }
    if (tocIndex.visibleEntries.length === 0) {
      setTocActivePath(null);
      return;
    }
    const isVisible = tocIndex.visibleEntries.some((entry) => entry.path === tocActivePath);
    if (!isVisible) {
      setTocActivePath(tocIndex.visibleEntries[0].path);
    }
  }, [tocOpen, tocIndex.visibleEntries, tocActivePath]);

  useEffect(() => {
    if (!tocOpen || !tocActivePath) {
      return;
    }
    const list = tocListRef.current;
    if (!list) {
      return;
    }
    const target = list.querySelector(
      `[data-toc-path="${tocActivePath}"]`,
    ) as HTMLElement | null;
    if (target) {
      target.scrollIntoView({ block: "nearest" });
    }
  }, [tocOpen, tocActivePath, tocExpandedPaths]);

  const renderTocItems = (items: TocItem[], depth = 0, parentPath: string | null = null) => {
    const listClassName = `${depth === 0 ? "space-y-5" : "space-y-1"} ${depth > 0 ? "pl-4" : ""}`;

    return (
      <ul className={listClassName}>
        {items.map((item, index) => {
          const path = parentPath ? `${parentPath}.${index}` : `${index}`;
          const isInteractive = item.page !== null;
          const isExpanded = tocExpandedPaths.has(path);
          const hasChildren = item.items.length > 0;
          const isSelected = tocActivePath === path;
          const indicator = hasChildren ? (isExpanded ? "-" : "+") : "";
          const toneByDepth =
            depth === 0
              ? "font-semibold text-primary"
              : depth === 1
                ? "font-medium text-foreground"
                : "text-foreground";
          const itemPadding = depth === 0 ? "py-1.5" : "py-0.5";
          const itemSpacing = depth === 0 ? "pb-3 last:pb-0" : "";

          return (
            <li key={`${depth}-${index}-${item.title}`} className={itemSpacing}>
              <button
                type="button"
                disabled={!isInteractive}
                data-toc-path={path}
                data-selected={isSelected}
                onClick={() => {
                  setTocActivePath(path);
                  if (item.page !== null) {
                    scrollToPage(item.page);
                  }
                }}
                className={`flex w-full items-start gap-2 text-left leading-5 transition-colors hover:bg-accent/40 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground ${toneByDepth} ${itemPadding} ${
                  isInteractive ? "hover:text-primary" : "cursor-default text-muted-foreground"
                }`}
              >
                <span
                  aria-hidden="true"
                  className="inline-flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground"
                >
                  {indicator}
                </span>
                <span className="min-w-0 flex-1">{item.title}</span>
              </button>
              {hasChildren && isExpanded ? renderTocItems(item.items, depth + 1, path) : null}
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

  useHotkeys(
    ":",
    () => {
      if (commandOpen) {
        return;
      }
      setCommandOpen(true);
      setCommandText(":");
    },
    {
      preventDefault: true,
      useKey: true,
    },
    [commandOpen],
  );

  useHotkeys(
    "o",
    () => {
      fileInputRef.current?.click();
    },
    {
      enabled: !commandOpen,
      preventDefault: true,
    },
    [commandOpen],
  );

  useHotkeys(
    "tab",
    () => {
      setTocOpen((current) => !current);
    },
    {
      enabled: Boolean(activeDocUrl) && !commandOpen,
      preventDefault: true,
    },
    [activeDocUrl, commandOpen],
  );

  useHotkeys(
    "escape",
    () => {
      setCommandOpen(false);
    },
    {
      enabled: commandOpen,
      enableOnFormTags: true,
      enableOnContentEditable: true,
      preventDefault: true,
    },
    [commandOpen],
  );

  const viewerHotkeysEnabled = Boolean(activeDocUrl) && !commandOpen;
  const viewerScrollHotkeysEnabled = viewerHotkeysEnabled && !tocOpen;
  const tocHotkeysEnabled = Boolean(activeDocUrl) && tocOpen && !commandOpen;

  const scrollByOffset = (deltaTop: number, deltaLeft: number) => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) {
      return;
    }
    scrollContainer.scrollBy({
      top: deltaTop,
      left: deltaLeft,
      behavior: "auto",
    });
  };

  const scrollByHalfPage = (direction: 1 | -1) => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) {
      return;
    }
    const halfPage = Math.max(1, Math.floor(scrollContainer.clientHeight / 2));
    scrollContainer.scrollBy({
      top: direction * halfPage,
      behavior: "auto",
    });
  };

  useHotkeys(
    ["equal", "shift+equal", "add"],
    () => {
      setZoomLevel((current) => Math.min(4, current + 0.1));
    },
    {
      enabled: viewerHotkeysEnabled,
      preventDefault: true,
    },
    [viewerHotkeysEnabled],
  );

  useHotkeys(
    ["minus", "subtract"],
    () => {
      setZoomLevel((current) => Math.max(0.4, current - 0.1));
    },
    {
      enabled: viewerHotkeysEnabled,
      preventDefault: true,
    },
    [viewerHotkeysEnabled],
  );

  useHotkeys(
    "s",
    () => {
      setZoomLevel(0.8);
    },
    {
      enabled: viewerHotkeysEnabled,
      preventDefault: true,
    },
    [viewerHotkeysEnabled],
  );

  useHotkeys(
    "j",
    () => {
      scrollByOffset(SCROLL_STEP_PX, 0);
    },
    {
      enabled: viewerScrollHotkeysEnabled,
      preventDefault: true,
    },
    [viewerScrollHotkeysEnabled],
  );

  useHotkeys(
    "k",
    () => {
      scrollByOffset(-SCROLL_STEP_PX, 0);
    },
    {
      enabled: viewerScrollHotkeysEnabled,
      preventDefault: true,
    },
    [viewerScrollHotkeysEnabled],
  );

  useHotkeys(
    "d",
    () => {
      scrollByHalfPage(1);
    },
    {
      enabled: viewerScrollHotkeysEnabled,
      preventDefault: true,
    },
    [viewerScrollHotkeysEnabled],
  );

  useHotkeys(
    "u",
    () => {
      scrollByHalfPage(-1);
    },
    {
      enabled: viewerScrollHotkeysEnabled,
      preventDefault: true,
    },
    [viewerScrollHotkeysEnabled],
  );

  useHotkeys(
    "j",
    () => {
      if (tocIndex.visibleEntries.length === 0) {
        return;
      }
      const currentIndex = tocIndex.visibleEntries.findIndex(
        (entry) => entry.path === tocActivePath,
      );
      const nextIndex =
        currentIndex === -1
          ? 0
          : (currentIndex + 1) % tocIndex.visibleEntries.length;
      setTocActivePath(tocIndex.visibleEntries[nextIndex]?.path ?? null);
    },
    {
      enabled: tocHotkeysEnabled,
      preventDefault: true,
    },
    [tocHotkeysEnabled, tocIndex.visibleEntries, tocActivePath],
  );

  useHotkeys(
    "k",
    () => {
      if (tocIndex.visibleEntries.length === 0) {
        return;
      }
      const currentIndex = tocIndex.visibleEntries.findIndex(
        (entry) => entry.path === tocActivePath,
      );
      const nextIndex =
        currentIndex === -1
          ? tocIndex.visibleEntries.length - 1
          : (currentIndex - 1 + tocIndex.visibleEntries.length) %
            tocIndex.visibleEntries.length;
      setTocActivePath(tocIndex.visibleEntries[nextIndex]?.path ?? null);
    },
    {
      enabled: tocHotkeysEnabled,
      preventDefault: true,
    },
    [tocHotkeysEnabled, tocIndex.visibleEntries, tocActivePath],
  );

  useHotkeys(
    "l",
    () => {
      if (!tocActivePath) {
        return;
      }
      const entry = tocIndex.entryByPath.get(tocActivePath);
      if (!entry || !entry.hasChildren) {
        return;
      }
      if (!tocExpandedPaths.has(tocActivePath)) {
        setTocExpandedPaths((current) => new Set(current).add(tocActivePath));
        return;
      }
      const firstChild = tocIndex.firstChildByPath.get(tocActivePath);
      if (firstChild) {
        setTocActivePath(firstChild);
      }
    },
    {
      enabled: tocHotkeysEnabled,
      preventDefault: true,
    },
    [tocHotkeysEnabled, tocActivePath, tocExpandedPaths, tocIndex],
  );

  useHotkeys(
    "h",
    () => {
      if (!tocActivePath) {
        return;
      }
      if (tocExpandedPaths.has(tocActivePath)) {
        setTocExpandedPaths((current) => {
          const next = new Set(current);
          next.delete(tocActivePath);
          return next;
        });
        return;
      }
      const parentPath = tocIndex.parentByPath.get(tocActivePath);
      if (parentPath) {
        setTocActivePath(parentPath);
      }
    },
    {
      enabled: tocHotkeysEnabled,
      preventDefault: true,
    },
    [tocHotkeysEnabled, tocActivePath, tocExpandedPaths, tocIndex],
  );

  useHotkeys(
    "f",
    () => {
      const nextMode = ((tocFoldMode + 1) % 3) as 0 | 1 | 2;
      setTocFoldMode(nextMode);
      if (nextMode === 0) {
        setTocExpandedPaths(new Set());
        return;
      }
      if (nextMode === 1) {
        setTocExpandedPaths(new Set(tocIndex.topLevelExpandablePaths));
        return;
      }
      setTocExpandedPaths(new Set(tocIndex.allExpandablePaths));
    },
    {
      enabled: tocHotkeysEnabled,
      preventDefault: true,
    },
    [tocHotkeysEnabled, tocFoldMode, tocIndex.topLevelExpandablePaths, tocIndex.allExpandablePaths],
  );

  useHotkeys(
    "enter",
    () => {
      if (!tocActivePath) {
        return;
      }
      const entry = tocIndex.entryByPath.get(tocActivePath);
      if (!entry || entry.item.page === null) {
        return;
      }
      scrollToPage(entry.item.page);
    },
    {
      enabled: tocHotkeysEnabled,
      preventDefault: true,
    },
    [tocHotkeysEnabled, tocActivePath, tocIndex.entryByPath],
  );

  useHotkeys(
    "g",
    () => {
      if (tocIndex.visibleEntries.length === 0) {
        return;
      }
      if (tocGPressTimeoutRef.current) {
        window.clearTimeout(tocGPressTimeoutRef.current);
        tocGPressTimeoutRef.current = null;
        setTocActivePath(tocIndex.visibleEntries[0]?.path ?? null);
        return;
      }
      tocGPressTimeoutRef.current = window.setTimeout(() => {
        tocGPressTimeoutRef.current = null;
      }, 320);
    },
    {
      enabled: tocHotkeysEnabled,
      preventDefault: true,
    },
    [tocHotkeysEnabled, tocIndex.visibleEntries],
  );

  useHotkeys(
    "shift+g",
    () => {
      if (tocIndex.visibleEntries.length === 0) {
        return;
      }
      const lastIndex = tocIndex.visibleEntries.length - 1;
      setTocActivePath(tocIndex.visibleEntries[lastIndex]?.path ?? null);
    },
    {
      enabled: tocHotkeysEnabled,
      preventDefault: true,
    },
    [tocHotkeysEnabled, tocIndex.visibleEntries],
  );

  const commandValue = commandOpen && !commandText ? ":" : commandText;
  const commandInput = commandValue.replace(/^:/, "");
  const trimmedCommand = commandInput.trimStart();
  const [commandName = "", ...commandArgsParts] = trimmedCommand.split(/\s+/);
  const normalizedCommandName = commandName.toLowerCase();
  const commandArgs = commandArgsParts.join(" ").trim();
  const themeQuery = normalizeThemeInput(commandArgs);
  const showThemeSuggestions = normalizedCommandName === "theme";
  const showRecentSuggestions = normalizedCommandName === "recent";
  const commandSuggestions = commandDefinitions.filter((command) =>
    normalizedCommandName ? command.name.startsWith(normalizedCommandName) : true,
  );
  const themeSuggestions = THEMES.filter((theme) => {
    if (!themeQuery) {
      return true;
    }
    return (
      theme.id.includes(themeQuery) ||
      theme.label.toLowerCase().includes(commandArgs.toLowerCase())
    );
  });
  const recentQuery = commandArgs.toLowerCase();
  const recentSuggestions = recentDocs.filter((doc) => {
    if (!recentQuery) {
      return true;
    }
    return (
      doc.label.toLowerCase().includes(recentQuery) ||
      (doc.url ? doc.url.toLowerCase().includes(recentQuery) : false) ||
      doc.sourceId.toLowerCase().includes(recentQuery)
    );
  });

  useEffect(() => {
    if (!showThemeSuggestions) {
      return;
    }
    setThemeHighlightIndex(0);
  }, [showThemeSuggestions, themeQuery]);

  useEffect(() => {
    if (!showThemeSuggestions) {
      return;
    }
    setThemeHighlightIndex((current) => {
      if (themeSuggestions.length === 0) {
        return 0;
      }
      return Math.min(current, themeSuggestions.length - 1);
    });
  }, [showThemeSuggestions, themeSuggestions.length]);

  useEffect(() => {
    if (!showThemeSuggestions) {
      return;
    }
    if (lastThemeInteractionRef.current !== "keyboard") {
      return;
    }
    const item = themeItemRefs.current[themeHighlightIndex];
    if (!item) {
      return;
    }
    requestAnimationFrame(() => {
      item.scrollIntoView({ block: "nearest" });
    });
  }, [showThemeSuggestions, themeHighlightIndex]);

  useEffect(() => {
    if (!showRecentSuggestions) {
      return;
    }
    setRecentHighlightIndex(0);
  }, [showRecentSuggestions, recentQuery]);

  useEffect(() => {
    if (!showRecentSuggestions) {
      return;
    }
    setRecentHighlightIndex((current) => {
      if (recentSuggestions.length === 0) {
        return 0;
      }
      return Math.min(current, recentSuggestions.length - 1);
    });
  }, [showRecentSuggestions, recentSuggestions.length]);

  useEffect(() => {
    if (!showRecentSuggestions) {
      return;
    }
    if (lastRecentInteractionRef.current !== "keyboard") {
      return;
    }
    const item = recentItemRefs.current[recentHighlightIndex];
    if (!item) {
      return;
    }
    requestAnimationFrame(() => {
      item.scrollIntoView({ block: "nearest" });
    });
  }, [showRecentSuggestions, recentHighlightIndex]);

  const previewTheme = (themeId: string) => {
    if (themeId !== activeTheme) {
      setActiveTheme(themeId);
    }
  };

  const commitTheme = (themeId: string) => {
    setActiveTheme(themeId);
    setCommandOpen(false);
  };

  const openRecentDoc = useCallback(
    (doc: RecentDoc) => {
      setCommandOpen(false);
      if (doc.source === "url" && doc.url) {
        openDocument(
          {
            key: doc.key,
            sourceId: doc.sourceId,
            label: doc.label,
            source: doc.source,
            url: doc.url,
          },
          doc.url,
        );
        return;
      }
      pendingRecentDocRef.current = doc;
      fileInputRef.current?.click();
    },
    [openDocument],
  );

  const handleCommandKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (showRecentSuggestions) {
      if (recentSuggestions.length === 0) {
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        lastRecentInteractionRef.current = "keyboard";
        const nextIndex = (recentHighlightIndex + 1) % recentSuggestions.length;
        setRecentHighlightIndex(nextIndex);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        lastRecentInteractionRef.current = "keyboard";
        const nextIndex =
          recentHighlightIndex === 0
            ? recentSuggestions.length - 1
            : recentHighlightIndex - 1;
        setRecentHighlightIndex(nextIndex);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        lastRecentInteractionRef.current = "keyboard";
        const selected = recentSuggestions[recentHighlightIndex];
        if (selected) {
          openRecentDoc(selected);
        }
      }
      return;
    }
    if (!showThemeSuggestions || themeSuggestions.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      lastThemeInteractionRef.current = "keyboard";
      const nextIndex = (themeHighlightIndex + 1) % themeSuggestions.length;
      setThemeHighlightIndex(nextIndex);
      previewTheme(themeSuggestions[nextIndex].id);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      lastThemeInteractionRef.current = "keyboard";
      const nextIndex =
        themeHighlightIndex === 0 ? themeSuggestions.length - 1 : themeHighlightIndex - 1;
      setThemeHighlightIndex(nextIndex);
      previewTheme(themeSuggestions[nextIndex].id);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      lastThemeInteractionRef.current = "keyboard";
      const selected = themeSuggestions[themeHighlightIndex];
      if (selected) {
        commitTheme(selected.id);
      }
    }
  };

  const handleCommandSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = commandValue.trim().replace(/^:/, "").trim();

    if (!input) {
      return;
    }

    const [name, ...rest] = input.split(/\s+/);
    const args = rest.join(" ");
    if (name === "theme") {
      const resolvedTheme = resolveTheme(args);
      if (!resolvedTheme && args && themeSuggestions.length === 1) {
        commitTheme(themeSuggestions[0].id);
        return;
      }
    }
    const definition = commandDefinitions.find((command) => command.name === name);

    if (!definition) {
      return;
    }

    const result = definition.run(args);

    if (result.ok) {
      setCommandOpen(false);
    }
  };

  const handleFileOpen = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (fileObjectUrlRef.current) {
      URL.revokeObjectURL(fileObjectUrlRef.current);
    }

    const objectUrl = URL.createObjectURL(file);
    fileObjectUrlRef.current = objectUrl;
    const pendingRecent = pendingRecentDocRef.current;
    pendingRecentDocRef.current = null;
    const meta = buildFileMeta(file);
    const resolvedMeta =
      pendingRecent && pendingRecent.key === meta.key
        ? {
            ...meta,
            label: pendingRecent.label,
            sourceId: pendingRecent.sourceId,
          }
        : meta;
    openDocument(resolvedMeta, objectUrl);
    setCommandOpen(false);
    event.target.value = "";
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        onChange={handleFileOpen}
        className="hidden"
      />
      {activeDocUrl ? (
        <div className="fixed inset-0 bg-background">
          <div className="flex h-full w-full">
            {tocOpen ? (
              <aside
                aria-label="Table of contents"
                className="flex h-full w-72 shrink-0 flex-col border-r border-border bg-card"
              >
                <div className="border-b border-border px-3 py-2 font-medium text-muted-foreground">
                  Contents
                </div>
                <ScrollArea className="flex-1" type="scroll" scrollHideDelay={600}>
                  <div ref={tocListRef} className="px-3 py-2">
                    {tocLoading ? (
                      <div className="text-muted-foreground">Loading...</div>
                    ) : tocItems.length > 0 ? (
                      renderTocItems(tocItems)
                    ) : (
                      <div className="text-muted-foreground">No table of contents.</div>
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
                <div ref={viewerRef} className="pdf-viewer flex w-full flex-col items-start" />
                {pdfLoading ? (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                    <div className="text-primary">
                      <Loader />
                    </div>
                  </div>
                ) : null}
                {pdfError ? <div className="mt-6 text-base text-destructive">{pdfError}</div> : null}
              </div>
            </ScrollArea>
          </div>
        </div>
      ) : (
        <div className="flex min-h-screen items-center justify-center px-6">
          <div className="w-full max-w-lg border border-border bg-card/80 px-5 py-4 text-base text-foreground backdrop-blur">
            <div className="flex items-center justify-between border-b border-border pb-2 font-mono uppercase tracking-[0.2em] text-muted-foreground">
              <span>zathura://home</span>
              <span className="text-primary">ready</span>
            </div>
            <div className="mt-3 space-y-1 font-mono">
              <div className="font-semibold text-primary">ZATHURA</div>
              <div className="text-muted-foreground">No document loaded.</div>
            </div>
            <div className="mt-4 space-y-2 font-mono">
              <div className="flex items-center gap-2">
                <span className="text-primary">:</span>
                <span>
                  open <span className="text-muted-foreground">&lt;url&gt;</span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-primary">:</span>
                <span>
                  theme <span className="text-muted-foreground">&lt;name&gt;</span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-primary">o</span>
                <span className="text-muted-foreground">open file picker</span>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                Open document
              </Button>
              <div className="flex items-center gap-2 font-mono text-muted-foreground">
                <span
                  className="inline-block h-3 w-2 animate-pulse bg-primary"
                  aria-hidden="true"
                />
                <span>waiting for input</span>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-border pt-2 font-mono uppercase tracking-[0.2em] text-muted-foreground">
              <span>-- idle --</span>
              <span>session:none</span>
            </div>
          </div>
        </div>
      )}

      {commandOpen ? (
        <div className="fixed inset-x-0 bottom-0 z-50 px-4 pb-6">
          <div className="relative mx-auto w-full max-w-3xl border border-border bg-card/90 p-3 shadow-lg backdrop-blur">
            <MentionRoot trigger=":" inputValue={commandValue} onInputValueChange={setCommandText}>
              <form onSubmit={handleCommandSubmit}>
                <MentionInput
                  ref={inputRef}
                  value={commandValue}
                  onKeyDown={handleCommandKeyDown}
                  className="w-full border border-border bg-background px-3 py-2 text-base text-foreground outline-none transition focus:border-primary"
                />
              </form>
              <div className="absolute left-0 right-0 bottom-full z-50 mb-2">
                {showRecentSuggestions ? (
                  <div
                    ref={recentListRef}
                    className="w-full max-h-64 overflow-auto border border-border bg-card p-1 text-base text-foreground shadow-lg"
                  >
                    {recentSuggestions.length > 0 ? (
                      recentSuggestions.map((doc, index) => (
                        <button
                          key={`${doc.key}-${doc.lastOpened}`}
                          type="button"
                          ref={(node) => {
                            recentItemRefs.current[index] = node;
                          }}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            openRecentDoc(doc);
                          }}
                          onMouseEnter={() => {
                            lastRecentInteractionRef.current = "mouse";
                            setRecentHighlightIndex(index);
                          }}
                          data-active={recentHighlightIndex === index}
                          className="flex w-full items-center justify-between gap-3 px-2 py-1 text-left text-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
                        >
                          <span className="min-w-0 flex-1 truncate">{doc.label}</span>
                          <span className="font-mono text-muted-foreground">p{doc.lastPage}</span>
                        </button>
                      ))
                    ) : (
                      <div className="px-2 py-1 text-muted-foreground">No recent documents.</div>
                    )}
                  </div>
                ) : showThemeSuggestions ? (
                  <div
                    ref={themeListRef}
                    className="w-full max-h-64 overflow-auto border border-border bg-card p-1 text-base text-foreground shadow-lg"
                  >
                    {themeSuggestions.length > 0 ? (
                      themeSuggestions.map((theme, index) => {
                        const isActiveTheme = theme.id === activeTheme;
                        return (
                          <button
                            key={theme.id}
                            type="button"
                            ref={(node) => {
                              themeItemRefs.current[index] = node;
                            }}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              commitTheme(theme.id);
                            }}
                            onMouseEnter={() => {
                              lastThemeInteractionRef.current = "mouse";
                              setThemeHighlightIndex(index);
                            }}
                            data-active={themeHighlightIndex === index}
                            className="flex w-full items-center justify-between gap-3 px-2 py-1 text-left text-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
                          >
                            <span className="flex min-w-0 flex-1 items-center gap-2">
                              <span
                                aria-hidden="true"
                                className={`w-3 text-primary ${isActiveTheme ? "opacity-100" : "opacity-0"}`}
                              >
                                *
                              </span>
                              <span className="truncate">{theme.label}</span>
                            </span>
                            <span className="font-mono text-muted-foreground">{theme.id}</span>
                          </button>
                        );
                      })
                    ) : (
                      <div className="px-2 py-1 text-muted-foreground">No themes found.</div>
                    )}
                  </div>
                ) : (
                  <MentionContent className="w-full border border-border bg-card p-1 text-base text-foreground shadow-lg">
                    {commandSuggestions.map((command) => (
                      <MentionItem
                        key={command.name}
                        value={command.name}
                        className="cursor-default px-2 py-1 text-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                      >
                        {command.signature}
                      </MentionItem>
                    ))}
                  </MentionContent>
                )}
              </div>
            </MentionRoot>
          </div>
        </div>
      ) : null}
    </div>
  );
}
