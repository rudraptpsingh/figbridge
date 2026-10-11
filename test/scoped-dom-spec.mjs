import assert from 'node:assert/strict';
import http from 'node:http';
import { urlToSpec, shutdown } from '../mcp/src/browser.js';

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><style>body{margin:0}button{box-sizing:border-box;width:56px;height:32px;border-radius:8px}</style><button data-testid="connections">Connections</button>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const spec = await urlToSpec(`http://127.0.0.1:${server.address().port}`, {
    width: 1280,
    rootSelector: '[data-testid="connections"]',
    embedImages: false,
  });
  assert.equal(spec._testid, 'connections');
  assert.equal(spec.width, 56);
  assert.equal(spec.height, 32);
  console.log('PASS scoped DOM anchor and measured component dimensions (3 assertions).');
} finally {
  await shutdown();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
