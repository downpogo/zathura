import { createMiddleware, createStart } from "@tanstack/react-start";

import { DEFAULT_THEME, THEME_COOKIE_KEY, resolveTheme, getCookieValueFromHeader } from "@/lib/theme";

const themeRequestMiddleware = createMiddleware().server(({ request, next }) => {
  const cookieHeader = request.headers.get("cookie");
  const cookieValue = getCookieValueFromHeader(cookieHeader, THEME_COOKIE_KEY);
  const resolved = cookieValue ? resolveTheme(cookieValue) : null;

  return next({
    context: {
      theme: resolved ?? DEFAULT_THEME,
    },
  });
});

export const startInstance = createStart(() => ({
  requestMiddleware: [themeRequestMiddleware],
}));
