/**
 * Builds the product site into site/dist.
 *
 * The site's source names the product only as {{NAME}}; the name comes from
 * the one constant in packages/config (see `pnpm check:product-name`). The
 * repository link comes from Vercel's build variables, else from git.
 *
 * No dependencies, so Vercel can run it without installing the workspace.
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (path) => `${root}${path}`;

const constant = readFileSync(at('packages/config/src/product.ts'), 'utf8');
const name = /export const PRODUCT_NAME = '([^']+)'/.exec(constant)?.[1];
if (!name) throw new Error('PRODUCT_NAME not found in packages/config/src/product.ts');

function repository() {
  const { VERCEL_GIT_REPO_OWNER: owner, VERCEL_GIT_REPO_SLUG: slug } = process.env;
  if (owner && slug) return { url: `https://github.com/${owner}/${slug}`, slug };
  try {
    const remote = execSync('git remote get-url origin', { cwd: root, encoding: 'utf8' }).trim();
    const match = /[:/]([^/:]+)\/([^/]+?)(\.git)?$/.exec(remote);
    if (match) return { url: `https://github.com/${match[1]}/${match[2]}`, slug: match[2] };
  } catch {
    // No git remote: fall through.
  }
  return { url: 'https://github.com', slug: name.toLowerCase() };
}

const repo = repository();
const fill = (file) => {
  const html = readFileSync(at(`site/src/${file}`), 'utf8')
    .replaceAll('{{NAME}}', name)
    .replaceAll('{{REPO_URL}}', repo.url)
    .replaceAll('{{REPO_SLUG}}', repo.slug);
  const left = /\{\{[A-Z_]+\}\}/.exec(html);
  if (left) throw new Error(`Unfilled placeholder in site/src/${file}: ${left[0]}`);
  return html;
};

const out = at('site/dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/shots`, { recursive: true });
writeFileSync(`${out}/index.html`, fill('index.html'));
writeFileSync(`${out}/poster.html`, fill('poster.html'));
cpSync(at('site/src/favicon.svg'), `${out}/favicon.svg`);
cpSync(at('docs/screenshots'), `${out}/shots`, { recursive: true });
console.log(`Built the site for ${name} into site/dist (repository: ${repo.url}).`);
