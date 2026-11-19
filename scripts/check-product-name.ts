/**
 * Fails if the product name is hard-coded anywhere it must not be.
 *
 * The name lives in one constant (packages/config/src/product.ts). Code,
 * configuration, package names and URLs must derive from it. This script
 * searches file contents and file names, ignoring case.
 *
 * Allowed:
 *   - the constant's own file;
 *   - a file NAMED after the manifest (its name is derived from the constant);
 *   - docs/ and README.md, which are prose for the team, not product text;
 *   - infra/demo/, which stands in for customers' own repositories. Those are
 *     written by the built skill and name the product they send metrics to,
 *     as a real customer's code would.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_FILENAME, PRODUCT_NAME } from '@app/config';

const root = fileURLToPath(new URL('..', import.meta.url));

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.git',
  'docs',
  'coverage',
  // Python's installed packages and tool caches: generated, git-ignored, and full of absolute paths.
  '.venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  // Local Railway variables and secrets (git-ignored).
  '.railway',
]);
const SKIP_PATHS = new Set(['infra/demo']);
const ALLOWED_CONTENT = new Set(['packages/config/src/product.ts', 'README.md']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|zip|gz)$/i;

const needle = PRODUCT_NAME.toLowerCase();
const problems: string[] = [];

function walk(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const shown = relative(root, path);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) || SKIP_PATHS.has(shown)) continue;
      if (entry.name.toLowerCase().includes(needle)) {
        problems.push(`${shown}/: directory name contains the product name`);
      }
      walk(path);
      continue;
    }
    if (!entry.isFile() || BINARY.test(entry.name)) continue;

    if (entry.name.toLowerCase().includes(needle) && basename(path) !== MANIFEST_FILENAME) {
      problems.push(`${shown}: file name contains the product name`);
    }
    if (ALLOWED_CONTENT.has(shown)) continue;

    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(needle)) {
        problems.push(`${shown}:${index + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
}

walk(root);

if (problems.length > 0) {
  console.error(
    `The product name is hard-coded in ${problems.length} place(s). ` +
      `Use PRODUCT_NAME, PRODUCT_SLUG or MANIFEST_FILENAME from @app/config instead:\n`,
  );
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('Product name check passed: the name appears only in its constant.');
