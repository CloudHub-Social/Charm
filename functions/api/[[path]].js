const HOP_BY_HOP_HEADERS = new Set([
  "connection",
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

function proxyHeaders(request) {
  const headers = new Headers(request.headers);
  for (const name of headers.keys()) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || name.startsWith("cf-")) {
      headers.delete(name);
    }
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
  const incomingPath =
    apiBase.pathname.replace(/\/+$/, "").endsWith("/api") &&
    incomingUrl.pathname.startsWith("/api/")
      ? incomingUrl.pathname.slice("/api".length)
      : incomingUrl.pathname;
  const relativePath = incomingPath.replace(/^\/+/, "");
  const targetUrl = new URL(`${relativePath}${incomingUrl.search}`, `${apiBase}/`);

  return fetch(targetUrl, {
    method: request.method,
    headers: proxyHeaders(request),
    body: request.body,
    redirect: "manual",
  });
}
