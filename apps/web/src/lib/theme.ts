export const DEFAULT_THEME = "tokyonight-night";

export const THEME_STORAGE_KEY = "zathura.theme";
export const THEME_COOKIE_KEY = "zathura.theme";

export const THEMES = [
  { id: "tokyonight-night", label: "Tokyo Night" },
  { id: "hackerman", label: "Hackerman" },
  { id: "matte-black", label: "Matte Black" },
  { id: "flexoki-light", label: "Flexoki Light" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const THEME_IDS = new Set<string>(THEMES.map((theme) => theme.id));

export const THEME_ALIASES: Record<string, ThemeId> = {
  "tokyo-night": "tokyonight-night",
  tokyonight: "tokyonight-night",

  // Friendly shortcuts
  hack: "hackerman",
  matte: "matte-black",
  flexoki: "flexoki-light",
};

export const normalizeThemeInput = (value: string) =>
  value.trim().toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");

export const resolveTheme = (value: string) => {
  const normalized = normalizeThemeInput(value);
  if (!normalized) {
    return null;
  }
  const resolved = THEME_ALIASES[normalized] ?? normalized;
  return THEME_IDS.has(resolved) ? (resolved as ThemeId) : null;
};

export const getCookieValueFromHeader = (cookieHeader: string | null, key: string) => {
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.trim().split("=");
    if (name === key) {
      return decodeURIComponent(rest.join("="));
    }
  }

  return null;
};

export const getCookieValue = (key: string) => {
  if (typeof document === "undefined") {
    return null;
  }

  return getCookieValueFromHeader(document.cookie ?? null, key);
};

export const getStoredTheme = () => {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored) {
      return resolveTheme(stored);
    }
  } catch {
    // Ignore storage failures.
  }

  const cookieValue = getCookieValue(THEME_COOKIE_KEY);
  return cookieValue ? resolveTheme(cookieValue) : null;
};

export const writeThemeCookie = (theme: string) => {
  if (typeof document === "undefined") {
    return;
  }

  const maxAge = 60 * 60 * 24 * 365;
  const secure = typeof window !== "undefined" && window.location.protocol === "https:";
  document.cookie = `${THEME_COOKIE_KEY}=${encodeURIComponent(theme)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure ? "; Secure" : ""}`;
};
