import { readFile } from 'node:fs/promises';

/** Read a rendered URL or a DOM spec captured from an already-running app.
 * The latter lets Electron Playwright supply its actual computed UI without
 * trying to reopen a private file:// app page in a separate Chrome process. */
export async function loadComparisonSpec(input, opts, urlToSpec) {
  const hasUrl = typeof input.url === 'string' && input.url.length > 0;
  const hasPath = typeof input.specPath === 'string' && input.specPath.length > 0;
  if (hasUrl === hasPath) throw new Error('Provide exactly one URL or captured spec path for each side.');
  const spec = hasPath
    ? JSON.parse(await readFile(input.specPath, 'utf8'))
    : await urlToSpec(input.url, opts);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || typeof spec.type !== 'string') {
    throw new Error('Comparison input must be a FigBridge spec object with a type.');
  }
  if (spec.type === 'frame' && (!Array.isArray(spec.children) || spec.children.length === 0)) {
    throw new Error('Captured frame spec is empty; inspect the matched app/design state before diffing.');
  }
  return spec;
}
