/** Minimal, dependency-free consent screen. */
export function renderLoginPage(options: {
  action: string;
  hidden: Record<string, string>;
  clientName: string;
  error?: string;
}): string {
  const esc = (value: string): string =>
    value.replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
    );

  const hiddenFields = Object.entries(options.hidden)
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join('\n      ');

  const error = options.error
    ? `<p class="error">${esc(options.error)}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in &middot; Yazio MCP</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      display: grid; place-items: center; min-height: 100vh; margin: 0;
      background: #f6f6f7; color: #18181b;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #18181b; color: #f4f4f5; }
      form { background: #27272a !important; border-color: #3f3f46 !important; }
      input { background: #18181b; color: inherit; border-color: #52525b !important; }
    }
    form {
      background: #fff; padding: 2rem; border-radius: 12px; width: min(90vw, 22rem);
      border: 1px solid #e4e4e7; box-shadow: 0 1px 3px rgb(0 0 0 / .08);
    }
    h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
    p.sub { margin: 0 0 1.25rem; color: #71717a; font-size: .875rem; }
    label { display: block; font-weight: 600; font-size: .8125rem; margin-bottom: .375rem; }
    input {
      width: 100%; padding: .55rem .7rem; border: 1px solid #d4d4d8;
      border-radius: 7px; font: inherit; box-sizing: border-box;
    }
    button {
      margin-top: 1.25rem; width: 100%; padding: .6rem; border: 0; border-radius: 7px;
      background: #2563eb; color: #fff; font: inherit; font-weight: 600; cursor: pointer;
    }
    button:hover { background: #1d4ed8; }
    .error {
      background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
      padding: .5rem .7rem; border-radius: 7px; font-size: .875rem; margin: 0 0 1rem;
    }
    @media (prefers-color-scheme: dark) {
      .error { background: #450a0a; color: #fca5a5; border-color: #7f1d1d; }
    }
  </style>
</head>
<body>
  <form method="post" action="${esc(options.action)}">
    <h1>Connect to Yazio MCP</h1>
    <p class="sub"><strong>${esc(options.clientName)}</strong> is requesting access to your Yazio data.</p>
    ${error}
    <label for="password">Server password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    ${hiddenFields}
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}
