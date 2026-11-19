import { MANIFEST_FILENAME } from '@app/config';
import { parseManifestYaml, type Manifest } from '@app/specs';

/** A route the code defines, and the handler behind it. */
export interface IndexedRoute {
  method: string;
  /** As the framework reports it in http.route: Express `/orders/:id`, FastAPI `/orders/{id}`. */
  route: string;
  file: string;
  /** The line the route is defined on. */
  line: number;
  /** The handler's lines, start and end inclusive. */
  span: [number, number];
  /** The handler's name, when it has one. */
  handler: string | null;
  /** The service the file belongs to: from the manifest in the same directory or above. */
  service: string | null;
  /** HTTP calls the handler makes to other services. */
  calls: string[];
  /** The handler's own lines. The index keeps these and nothing else of the code. */
  snippet: string;
}

export interface CodeIndex {
  commit: string;
  routes: IndexedRoute[];
  manifests: { path: string; manifest: Manifest | null; error?: string }[];
  /** Source files read, for coverage reporting. */
  files: string[];
}

const SOURCE = /\.(c?js|mjs|ts|py)$/;

/** Where a handler ends: Python by indentation, JavaScript by brace depth from the route call. */
function spanOf(lines: string[], start: number, python: boolean): [number, number] {
  if (python) {
    const def = lines.findIndex((text, i) => i > start && /^\s*(async\s+)?def\s/.test(text));
    if (def === -1) return [start + 1, start + 1];
    const indent = /^(\s*)/.exec(lines[def]!)![1]!.length;
    let end = def;
    for (let i = def + 1; i < lines.length; i += 1) {
      const text = lines[i]!;
      if (text.trim() === '') continue;
      if (/^(\s*)/.exec(text)![1]!.length <= indent) break;
      end = i;
    }
    return [start + 1, end + 1];
  }
  let depth = 0;
  let seen = false;
  for (let i = start; i < lines.length; i += 1) {
    for (const char of lines[i]!) {
      if (char === '{' || char === '(') {
        depth += 1;
        seen = true;
      } else if (char === '}' || char === ')') {
        depth -= 1;
      }
    }
    if (seen && depth <= 0) return [start + 1, i + 1];
  }
  return [start + 1, lines.length];
}

const EXPRESS = /\b(?:app|router)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/;
const FASTAPI = /^\s*@(?:app|router)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/;

/** Build the index of a repository from its files at one commit. */
export function buildIndex(commit: string, files: Map<string, string>): CodeIndex {
  const manifests = [...files.keys()]
    .filter((path) => path.split('/').pop() === MANIFEST_FILENAME)
    .map((path) => {
      try {
        return { path, manifest: parseManifestYaml(files.get(path)!) };
      } catch (error) {
        return {
          path,
          manifest: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  /** The manifest of the nearest directory at or above a file. */
  const serviceOf = (file: string) => {
    let dir = file.split('/').slice(0, -1);
    for (;;) {
      const path = [...dir, MANIFEST_FILENAME].join('/');
      const found = manifests.find((m) => m.path === path);
      if (found) return found.manifest?.service ?? null;
      if (dir.length === 0) return null;
      dir = dir.slice(0, -1);
    }
  };

  const routes: IndexedRoute[] = [];
  const sources = [...files.keys()].filter(
    (path) => SOURCE.test(path) && !/(^|\/)(node_modules|test|tests|\.venv)\//.test(path),
  );
  for (const file of sources) {
    const lines = files.get(file)!.split('\n');
    const python = file.endsWith('.py');
    lines.forEach((text, index) => {
      const match = (python ? FASTAPI : EXPRESS).exec(text);
      if (!match) return;
      const span = spanOf(lines, index, python);
      const body = lines.slice(span[0] - 1, span[1]).join('\n');
      const handler = python
        ? (/def\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body)?.[1] ?? null)
        : (/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(body)?.[1] ?? null);
      const calls = [
        ...body.matchAll(
          /(?:fetch|axios\.\w+|httpx\.\w+|requests\.\w+|client\.\w+)\(\s*[`'"]?([^`'",)]+)/g,
        ),
      ]
        .map((m) => m[1]!.trim())
        .filter((target) => /\$\{|https?:|_URL|url/i.test(target));
      routes.push({
        method: match[1]!.toUpperCase(),
        route: match[2]!,
        file,
        line: index + 1,
        span,
        handler,
        service: serviceOf(file),
        calls,
        snippet: body,
      });
    });
  }
  return { commit, routes, manifests, files: sources };
}

/** The handler behind an endpoint, matched on method, route template and service. */
export function findHandler(
  index: CodeIndex,
  endpoint: { service: string; method: string; route: string },
): IndexedRoute | undefined {
  return index.routes.find(
    (r) =>
      r.method === endpoint.method &&
      r.route === endpoint.route &&
      (r.service === null || r.service === endpoint.service),
  );
}
