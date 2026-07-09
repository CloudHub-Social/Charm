const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function previewApiBase(env) {
  const configured = env.CHARM_WEB_API_BASE_URL;
  if (typeof configured !== "string" || configured.trim() === "") {
    return {
      response: new Response("CHARM_WEB_API_BASE_URL is not configured", {
        status: 502,
      }),
    };
  }

  try {
    const url = new URL(configured.replace(/\/+$/, ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        response: new Response("CHARM_WEB_API_BASE_URL must use http or https", { status: 502 }),
      };
    }
    if (url.search !== "" || url.hash !== "") {
      return {
        response: new Response(
          "CHARM_WEB_API_BASE_URL must not include a query string or fragment",
          { status: 502 },
        ),
      };
    }
    return { url };
  } catch {
    return {
      response: new Response("CHARM_WEB_API_BASE_URL must be an absolute URL", {
        status: 502,
      }),
    };
  }
}

function proxyHeaders(request, { preserveUpgrade = false } = {}) {
  const headers = new Headers(request.headers);
  const namesToDelete = [];
  for (const name of Array.from(headers.keys())) {
    const normalizedName = name.toLowerCase();
    if (
      (HOP_BY_HOP_HEADERS.has(normalizedName) &&
        (!preserveUpgrade || (normalizedName !== "connection" && normalizedName !== "upgrade"))) ||
      normalizedName === "host" ||
      normalizedName.startsWith("cf-")
    ) {
      namesToDelete.push(name);
    }
  }
  for (const name of namesToDelete) {
    headers.delete(name);
  }
  return headers;
}

export async function onRequest({ env, request }) {
  const result = previewApiBase(env);
  if (result.response) {
    return result.response;
  }

  const apiBase = result.url;
  const incomingUrl = new URL(request.url);
  const apiBasePath = apiBase.pathname.replace(/\/+$/, "");
  const shouldStripApiPrefix =
    apiBasePath.endsWith("/api") &&
    (incomingUrl.pathname === "/api" || incomingUrl.pathname.startsWith("/api/"));
  const incomingPath =
    shouldStripApiPrefix && incomingUrl.pathname === "/api"
      ? ""
      : shouldStripApiPrefix
        ? incomingUrl.pathname.slice("/api".length)
        : incomingUrl.pathname;
  const relativePath = incomingPath.replace(/^\/+/, "");
  const targetUrl = new URL(apiBase);
  const basePath = targetUrl.pathname.replace(/\/+$/, "");
  targetUrl.pathname = `${basePath}/${relativePath}`;
  targetUrl.search = incomingUrl.search;
  const preserveUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";

  return fetch(targetUrl, {
    method: request.method,
    headers: proxyHeaders(request, { preserveUpgrade }),
    body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
    redirect: "manual",
  });
}
