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
    if (url.username !== "" || url.password !== "") {
      return {
        response: new Response("CHARM_WEB_API_BASE_URL must not include credentials", {
          status: 502,
        }),
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

function containsDotSegment(path) {
  for (const segment of path.split("/")) {
    let decodedSegment = segment;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decodedSegment.split(/[\\/]/).some((part) => part === "." || part === "..")) {
      return true;
    }
  }
  return false;
}

function proxyHeaders(request, { preserveUpgrade = false } = {}) {
  const headers = new Headers(request.headers);
  const connectionTokens = new Set(
    (headers.get("connection") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  const namesToDelete = [];
  for (const name of Array.from(headers.keys())) {
    const normalizedName = name.toLowerCase();
    if (
      (HOP_BY_HOP_HEADERS.has(normalizedName) &&
        (!preserveUpgrade || (normalizedName !== "connection" && normalizedName !== "upgrade"))) ||
      (connectionTokens.has(normalizedName) &&
        (!preserveUpgrade || (normalizedName !== "connection" && normalizedName !== "upgrade"))) ||
      normalizedName === "host" ||
      normalizedName === "proxy-connection" ||
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
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin !== null && requestOrigin !== incomingUrl.origin) {
    return new Response("Preview API proxy origin is not allowed", {
      status: 403,
    });
  }
  if (incomingUrl.pathname !== "/api" && !incomingUrl.pathname.startsWith("/api/")) {
    return new Response("Preview API proxy only accepts /api requests", {
      status: 400,
    });
  }
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
  if (containsDotSegment(relativePath)) {
    return new Response("Preview API proxy path must not include dot segments", {
      status: 400,
    });
  }
  const targetUrl = new URL(apiBase);
  const basePath = targetUrl.pathname.replace(/\/+$/, "");
  targetUrl.pathname = relativePath === "" ? basePath || "/" : `${basePath}/${relativePath}`;
  targetUrl.search = incomingUrl.search;
  const preserveUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;
  const fetchOptions = {
    method: request.method,
    headers: proxyHeaders(request, {
      preserveUpgrade,
    }),
    body,
    redirect: "manual",
  };
  if (body !== null) {
    fetchOptions.duplex = "half";
  }

  return fetch(targetUrl, fetchOptions);
}
