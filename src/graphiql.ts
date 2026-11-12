// GraphiQL page (assets from a CDN, pinned versions).

export interface GraphiQLOptions {
  /** Endpoint the IDE talks to (default: the current URL). */
  endpoint?: string
  title?: string
  /** CSRF token sent as `headerName` with every request (session-authenticated mutations). */
  csrfToken?: string
  csrfHeaderName?: string
  /** Initial query in the editor. */
  defaultQuery?: string
  /** Extra headers sent with every request. */
  headers?: Record<string, string>
}

export const GRAPHIQL_VERSION = '3.8.3'
export const REACT_VERSION = '18.3.1'

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  )
}

/** JSON safe to embed in a `<script>` tag. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

/** The GraphiQL HTML page. */
export function renderGraphiQL(opts: GraphiQLOptions = {}): string {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.csrfToken) headers[opts.csrfHeaderName ?? 'X-CSRFToken'] = opts.csrfToken
  const config = { endpoint: opts.endpoint ?? null, headers, defaultQuery: opts.defaultQuery ?? null }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(opts.title ?? 'GraphiQL')}</title>
<style>html,body,#graphiql{height:100%;margin:0;overflow:hidden}</style>
<link rel="stylesheet" href="https://unpkg.com/graphiql@${GRAPHIQL_VERSION}/graphiql.min.css" crossorigin="anonymous" />
</head>
<body>
<div id="graphiql">Loading GraphiQL…</div>
<script src="https://unpkg.com/react@${REACT_VERSION}/umd/react.production.min.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@${REACT_VERSION}/umd/react-dom.production.min.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/graphiql@${GRAPHIQL_VERSION}/graphiql.min.js" crossorigin="anonymous"></script>
<script>
(function () {
  var config = ${scriptJson(config)};
  var url = config.endpoint || (window.location.pathname);
  var fetcher = GraphiQL.createFetcher({ url: url, headers: config.headers, credentials: 'same-origin' });
  var props = { fetcher: fetcher, defaultEditorToolsVisibility: true };
  if (config.defaultQuery) props.defaultQuery = config.defaultQuery;
  ReactDOM.createRoot(document.getElementById('graphiql')).render(React.createElement(GraphiQL, props));
})();
</script>
</body>
</html>`
}
