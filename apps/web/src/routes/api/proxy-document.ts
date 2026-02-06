import { createFileRoute } from "@tanstack/react-router";

const EXPOSED_HEADERS = [
  "Accept-Ranges",
  "Content-Length",
  "Content-Range",
  "Content-Type",
  "ETag",
  "Last-Modified",
].join(", ");

const corsBaseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  // Range is important for pdf.js incremental loading.
  "Access-Control-Allow-Headers": "Range, If-None-Match, If-Modified-Since, Content-Type",
  "Access-Control-Expose-Headers": EXPOSED_HEADERS,
} as const;

const isBlockedHostname = (hostname: string) => {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "127.0.0.1" || lower === "0.0.0.0" || lower === "::1";
};

const pickHeader = (headers: Headers, name: string) => {
  const value = headers.get(name);
  return value ?? undefined;
};

const isPdfContentType = (value: string | null) => {
  if (!value) return false;
  const [type] = value.split(";");
  return type.trim().toLowerCase() === "application/pdf";
};

export const Route = createFileRoute("/api/proxy-document")({
  server: {
    handlers: {
      OPTIONS: async () => {
        return new Response(null, {
          status: 204,
          headers: {
            ...corsBaseHeaders,
          },
        });
      },

      HEAD: async ({ request }) => {
        return handleProxy(request, { includeBody: false });
      },

      GET: async ({ request }) => {
        return handleProxy(request, { includeBody: true });
      },
    },
  },
});

async function handleProxy(request: Request, opts: { includeBody: boolean }): Promise<Response> {
  const requestUrl = new URL(request.url);
  const target = requestUrl.searchParams.get("url");

  if (!target) {
    return new Response("Missing ?url=", {
      status: 400,
      headers: {
        ...corsBaseHeaders,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(target);
  } catch {
    return new Response("Invalid url", {
      status: 400,
      headers: {
        ...corsBaseHeaders,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  if (upstreamUrl.protocol !== "http:" && upstreamUrl.protocol !== "https:") {
    return new Response("Only http(s) urls are allowed", {
      status: 400,
      headers: {
        ...corsBaseHeaders,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  // Basic SSRF mitigation. For production, prefer a strict allowlist.
  if (isBlockedHostname(upstreamUrl.hostname)) {
    return new Response("Blocked host", {
      status: 403,
      headers: {
        ...corsBaseHeaders,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  const upstreamHeaders = new Headers();

  const range = pickHeader(request.headers, "range");
  if (range) upstreamHeaders.set("range", range);

  const ifNoneMatch = pickHeader(request.headers, "if-none-match");
  if (ifNoneMatch) upstreamHeaders.set("if-none-match", ifNoneMatch);

  const ifModifiedSince = pickHeader(request.headers, "if-modified-since");
  if (ifModifiedSince) upstreamHeaders.set("if-modified-since", ifModifiedSince);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "follow",
    });
  } catch {
    return new Response("Upstream fetch failed", {
      status: 502,
      headers: {
        ...corsBaseHeaders,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  const upstreamContentType = upstream.headers.get("content-type");
  const isPdf = isPdfContentType(upstreamContentType);
  const isNotModified = upstream.status === 304;

  if (!isPdf && !isNotModified) {
    return new Response("Only application/pdf content is allowed", {
      status: 415,
      headers: {
        ...corsBaseHeaders,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(corsBaseHeaders)) {
    headers.set(key, value);
  }

  // Forward important PDF/viewer related headers.
  const passthrough = [
    "accept-ranges",
    "content-range",
    "content-length",
    "content-type",
    "etag",
    "last-modified",
    "cache-control",
  ] as const;

  for (const name of passthrough) {
    const value = upstream.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }

  // Help PDFs display instead of downloading in some contexts.
  if (!headers.get("content-disposition")) {
    headers.set("content-disposition", "inline");
  }

  const body = opts.includeBody ? upstream.body : null;

  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
