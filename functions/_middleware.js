// Pages serves this whole repo as the website, so repo-only files like wrangler.toml and the
// function source would otherwise be downloadable. Those paths get a plain 404; every other
// request (the API and the normal pages) passes straight through. _routes.json keeps this
// from running on normal page views at all in production.
const BLOCKED = /^\/(?:wrangler\.toml|\.gitignore|_routes\.json|functions(?:\/|$))/i;

const NOT_FOUND = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page Not Found | 8888 Media</title>
</head>
<body style="margin:0;padding:64px 20px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center;background:#FBFAF8;color:#18161B">
<h1 style="margin:0 0 12px">Page Not Found</h1>
<p style="margin:0"><a href="/" style="color:#CF1656">Go to the 8888 Media homepage</a></p>
</body>
</html>`;

export async function onRequest({ request, next }) {
  const { pathname } = new URL(request.url);
  if (!BLOCKED.test(pathname)) return next();
  return new Response(NOT_FOUND, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
