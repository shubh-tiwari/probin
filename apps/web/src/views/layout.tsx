/** @jsxRuntime automatic @jsxImportSource hono/jsx */
import { PRODUCT_NAME } from '@app/config';
import type { Child } from 'hono/jsx';
import { raw } from 'hono/html';
import { COLORS, DARK_COLORS } from '../theme.js';

/** CSS custom properties for one palette. */
const vars = (selector: string, c: typeof COLORS) =>
  `${selector}{color-scheme:${c === COLORS ? 'light' : 'dark'};--page:${c.page};--surface:${c.surface};--text:${c.text};--secondary:${c.secondary};--muted:${c.muted};--border:${c.border};--control:${c.control};--divider:${c.divider};--accent:${c.accent};--accent-hover:${c.accentHover};--accent-button:${c.accentButton};--on-accent:${c.onAccent};--accent-soft:${c.accentSoft};--accent-soft-text:${c.accentSoftText};--warning:${c.warning};--on-warning:${c.onWarning};--pending-bg:${c.pendingBg};--pending-text:${c.pendingText};--danger:${c.danger}}`;

const CSS = `
${vars(':root', COLORS)}
.chart-dark{display:none}
@media (prefers-color-scheme: dark){${vars(':root', DARK_COLORS)} .chart-light{display:none} .chart-dark{display:block}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--text);font:15px/1.5 Inter,system-ui,sans-serif}
a{color:var(--accent)}a:hover{color:var(--accent-hover)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
h1,h2,h3{margin:0}
code,pre{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px}
.brand{font-family:'Space Grotesk',Inter,sans-serif;font-weight:600;font-size:18px;color:var(--text);text-decoration:none}
.top{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;padding:12px 24px;background:var(--surface);border-bottom:1px solid var(--border)}
.top h1{font-size:16px;font-weight:600;flex:1 1 200px}
.top nav{display:flex;gap:4px;flex-wrap:wrap}
.top nav a{display:inline-flex;align-items:center;min-height:44px;padding:0 10px;border-radius:8px;text-decoration:none;color:var(--secondary)}
.top nav a[aria-current=page]{background:var(--accent-soft);color:var(--accent-soft-text);font-weight:600}
.status{font-size:12px;color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 14px;border-radius:8px;border:1px solid var(--control);background:var(--surface);color:var(--text);font:inherit;font-weight:500;cursor:pointer;text-decoration:none}
.btn:hover{border-color:var(--muted)}
.btn.primary{background:var(--accent-button);border-color:var(--accent-button);color:var(--on-accent)}
.btn.primary:hover{filter:brightness(1.1)}
.btn.chip{border-radius:999px;font-size:13px;color:var(--secondary)}
.btn.icon{width:44px;padding:0}
.btn[aria-pressed=true]{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-soft-text)}
.cols{display:flex;flex-wrap:wrap}
.ask{flex:1 1 360px;max-width:100%;background:var(--surface);border-right:1px solid var(--border);padding:20px;display:flex;flex-direction:column;gap:16px}
.ask h2{font-family:'Space Grotesk',Inter,sans-serif;font-size:16px;font-weight:600}
.bubble{margin:0;align-self:flex-end;max-width:85%;background:var(--accent-soft);color:var(--accent-soft-text);border-radius:12px;padding:10px 14px}
.card{border:1px solid var(--border);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--surface)}
.card h3{font-size:14px;font-weight:600}
.step{font-size:12px;font-weight:600;color:var(--muted);margin-right:8px}
.field{display:flex;flex-direction:column;gap:6px}
.field label,.label{font-size:13px;font-weight:500;color:var(--secondary)}
input[type=text],textarea,select{min-height:44px;border:1px solid var(--control);border-radius:8px;padding:0 12px;font:inherit;color:var(--text);background:var(--surface)}
textarea{padding:10px 12px;min-height:88px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;width:100%}
.prompt{display:flex;gap:8px;border:1px solid var(--control);border-radius:10px;padding:8px}
.prompt input{flex:1;min-width:0;border:0}
.choices{display:flex;flex-wrap:wrap;gap:8px}
.endpoints{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;max-height:360px;overflow:auto}
.endpoints label{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 10px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.endpoints label:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}
.endpoints input{width:18px;height:18px;margin:0;accent-color:var(--accent)}
.endpoints .path{flex:1;min-width:0;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;overflow-wrap:anywhere}
.tag{font-size:12px;color:var(--secondary);background:var(--divider);border-radius:999px;padding:2px 10px;white-space:nowrap}
.badge{font-size:12px;font-weight:500;border-radius:999px;padding:2px 10px;background:var(--accent-soft);color:var(--accent-soft-text);white-space:nowrap}
.badge.pending{background:var(--pending-bg);color:var(--pending-text)}
.badge.firing{background:var(--warning);color:var(--on-warning);font-weight:600}
.badge.ok{background:var(--divider);color:var(--secondary)}
.main{flex:999 1 560px;min-width:0;padding:20px;display:flex;flex-direction:column;gap:16px}
.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px}
.panel{min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px}
.panel.new{border-color:var(--accent)}
.panel.draft{border:1px dashed var(--accent)}
.panel header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.panel h2{font-size:14px;font-weight:600;overflow-wrap:anywhere}
.chart svg{width:100%;height:auto;display:block}
.query{display:block;background:var(--page);color:var(--secondary);border-radius:6px;padding:8px 10px;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.reading{margin:0;font-size:13px;color:var(--secondary)}
dl.facts{margin:0;display:grid;grid-template-columns:110px minmax(0,1fr);gap:4px 12px;font-size:13px}
dl.facts dt{color:var(--muted)}dl.facts dd{margin:0}
details summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-size:13px;color:var(--secondary)}
.error{color:var(--danger);font-size:13px;margin:0}
.notice{background:var(--accent-soft);color:var(--accent-soft-text);border-radius:8px;padding:10px 14px;margin:0}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.empty{color:var(--muted);margin:0}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--divider);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}
.page{max-width:1100px;margin:0 auto;padding:24px;display:flex;flex-direction:column;gap:16px}
@media (max-width:900px){.grid > *{grid-column:1 / -1 !important}.ask{border-right:0;border-bottom:1px solid var(--border)}}
`;

export function Layout(props: { title: string; children: Child; scripts?: boolean }) {
  return (
    <>
      {raw('<!doctype html>')}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <title>{`${props.title} · ${PRODUCT_NAME}`}</title>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link
            rel="stylesheet"
            href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600&family=JetBrains+Mono:wght@400&display=swap"
          />
          <style>{raw(CSS)}</style>
        </head>
        <body>
          {props.children}
          {props.scripts ? <script src="/app.js" defer></script> : null}
        </body>
      </html>
    </>
  );
}

/** The bar across the top of every signed-in page. */
export function TopBar(props: {
  title: string;
  current: 'dashboard' | 'memory' | 'alerts' | 'collectors' | 'settings' | 'review';
  extra?: Child;
  userName: string;
}) {
  return (
    <header class="top">
      <a class="brand" href="/">
        {PRODUCT_NAME}
      </a>
      <h1>{props.title}</h1>
      <nav aria-label="Pages">
        <a href="/" aria-current={props.current === 'dashboard' ? 'page' : undefined}>
          Dashboard
        </a>
        <a href="/alerts" aria-current={props.current === 'alerts' ? 'page' : undefined}>
          Alerts
        </a>
        <a href="/collectors" aria-current={props.current === 'collectors' ? 'page' : undefined}>
          Data sources
        </a>
        <a href="/review" aria-current={props.current === 'review' ? 'page' : undefined}>
          Review
        </a>
        <a href="/memory" aria-current={props.current === 'memory' ? 'page' : undefined}>
          Memory
        </a>
        <a href="/settings" aria-current={props.current === 'settings' ? 'page' : undefined}>
          Settings
        </a>
        <a href="/billing">Billing</a>
      </nav>
      {props.extra}
      <form method="post" action="/logout">
        <button class="btn" type="submit">
          Sign out {props.userName}
        </button>
      </form>
    </header>
  );
}

export function MessagePage(props: {
  title: string;
  text: string;
  action?: { href: string; label: string };
}) {
  return (
    <Layout title={props.title}>
      <main class="page">
        <span class="brand">{PRODUCT_NAME}</span>
        <h1>{props.title}</h1>
        <p>{props.text}</p>
        {props.action ? (
          <p>
            <a class="btn primary" href={props.action.href}>
              {props.action.label}
            </a>
          </p>
        ) : null}
      </main>
    </Layout>
  );
}
