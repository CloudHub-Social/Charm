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
    return { url: new URL(configured.replace(/\/+$/, "")) };
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
      (!preserveUpgrade && HOP_BY_HOP_HEADERS.has(normalizedName)) ||
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
  const targetUrl = new URL(`${relativePath}${incomingUrl.search}`, `${apiBase}/`);
  const preserveUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";

  return fetch(targetUrl, {
    method: request.method,
    headers: proxyHeaders(request, { preserveUpgrade }),
    body: request.body,
    redirect: "manual",
  });
}
