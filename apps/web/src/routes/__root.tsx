import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import { getGlobalStartContext } from "@tanstack/react-start";

import { Toaster } from "@/components/ui/sonner";
import {
  DEFAULT_THEME,
  THEME_ALIASES,
  THEME_COOKIE_KEY,
  THEME_STORAGE_KEY,
  THEMES,
  getStoredTheme,
} from "@/lib/theme";

import appCss from "../index.css?url";

export interface RouterAppContext { }

export const Route = createRootRouteWithContext<RouterAppContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "description", content: "A minimal, Vim-style document viewer." },
      { property: "og:title", content: "Zathura" },
      { property: "og:description", content: "A minimal, Vim-style document viewer." },
      {
        title: "Zathura",
      },
    ],
    links: [
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/logo.svg",
      },
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),

  component: RootDocument,
});

const themeInitScript = `(() => {
  try {
    const DEFAULT = ${JSON.stringify(DEFAULT_THEME)};
    const STORAGE_KEY = ${JSON.stringify(THEME_STORAGE_KEY)};
    const COOKIE_KEY = ${JSON.stringify(THEME_COOKIE_KEY)};
    const IDS = ${JSON.stringify(THEMES.map((theme) => theme.id))};
    const ALIASES = ${JSON.stringify(THEME_ALIASES)};

    const normalize = (value) =>
      String(value).trim().toLowerCase().replace(/_/g, "-").replace(/\\s+/g, "-");

    const resolve = (value) => {
      if (value == null) return null;
      const normalized = normalize(value);
      if (!normalized) return null;
      const resolved = ALIASES[normalized] || normalized;
      return IDS.includes(resolved) ? resolved : null;
    };

    const getCookie = (key) => {
      const cookies = document.cookie ? document.cookie.split(";") : [];
      for (const cookie of cookies) {
        const [name, ...rest] = cookie.trim().split("=");
        if (name === key) {
          return decodeURIComponent(rest.join("="));
        }
      }
      return null;
    };

    let theme = null;

    try {
      theme = resolve(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      // Ignore storage failures.
    }

    if (!theme) {
      theme = resolve(getCookie(COOKIE_KEY));
    }

    if (!theme) {
      theme = DEFAULT;
    }

    document.documentElement.dataset.theme = theme;
  } catch {
    // Ignore theme init failures.
  }
})();`;

function RootDocument() {
  const serverTheme = (() => {
    if (typeof window !== "undefined") {
      return null;
    }

    try {
      return (getGlobalStartContext() as { theme?: string } | undefined)?.theme ?? null;
    } catch {
      return null;
    }
  })();

  const initialTheme = (typeof window === "undefined" ? serverTheme : getStoredTheme()) ?? DEFAULT_THEME;

  return (
    <html lang="en" className="dark" data-theme={initialTheme} suppressHydrationWarning>
      <head>
        <script id="theme-init" dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <HeadContent />
      </head>
      <body>
        <div className="grid h-svh grid-rows-[auto_1fr]">
          <Outlet />
        </div>
        <Toaster richColors />
        <Scripts />
      </body>
    </html>
  );
}
