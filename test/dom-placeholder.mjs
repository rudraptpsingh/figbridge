import { urlToSpec, shutdown } from '../mcp/src/browser.js';

const html = `<!doctype html><style>
  body { margin: 0; background: #141414; }
  input { width: 200px; height: 32px; color: #ffffff; }
  input::placeholder { color: rgb(148, 148, 148); opacity: .75; }
</style><input type="search" aria-label="Search" placeholder="Search photos">
<input aria-label="Untyped" placeholder="Untyped search">`;

try {
  const spec = await urlToSpec(`data:text/html,${encodeURIComponent(html)}`,
    { width: 400, height: 200, settleMs: 1, embedImages: false });
  const find = (node) => node.characters === 'Search photos'
    ? node : (node.children || []).map(find).find(Boolean);
  const placeholder = find(spec);
  if (!placeholder || placeholder.color !== '#949494' || placeholder.opacity !== 0.75)
    throw new Error(`placeholder must use computed pseudo-element paint, got ${JSON.stringify(placeholder)}`);
  const findUntyped = (node) => node.characters === 'Untyped search'
    ? node : (node.children || []).map(findUntyped).find(Boolean);
  if (!findUntyped(spec)) throw new Error('an input without a type attribute must default to text');
  console.log('PASS  computed placeholder paint and default input type (2 browser assertions).');
} finally {
  await shutdown();
}
