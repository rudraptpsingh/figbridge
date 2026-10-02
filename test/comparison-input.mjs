#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadComparisonSpec } from '../mcp/src/comparison-input.js';

const dir = await mkdtemp(join(tmpdir(), 'figbridge-spec-input-'));
try {
  const path = join(dir, 'electron.json');
  const spec = { type: 'frame', name: 'Native Cull', width: 1440, height: 900, children: [
    { type: 'text', name: 'Export', characters: 'Export 186', fontSize: 12 },
  ] };
  await writeFile(path, JSON.stringify(spec));
  const fromFile = await loadComparisonSpec({ specPath: path }, { width: 1440 }, () => {
    throw new Error('URL loader must not run for captured Electron JSON');
  });
  assert.deepEqual(fromFile, spec);
  const fromUrl = await loadComparisonSpec({ url: 'http://localhost/figma.html' }, { width: 1440 },
    async (_url, opts) => { assert.equal(opts.width, 1440); return spec; });
  assert.deepEqual(fromUrl, spec);
  await assert.rejects(loadComparisonSpec({}, {}, async () => spec), /exactly one/);
  await assert.rejects(loadComparisonSpec({ url: 'http://a', specPath: path }, {}, async () => spec), /exactly one/);
  const bad = join(dir, 'invalid.json');
  await writeFile(bad, '{bad');
  await assert.rejects(loadComparisonSpec({ specPath: bad }, {}, async () => spec), /JSON/);
  const empty = join(dir, 'empty.json');
  await writeFile(empty, JSON.stringify({ type: 'frame', children: [] }));
  await assert.rejects(loadComparisonSpec({ specPath: empty }, {}, async () => spec), /empty/);
  const actual = join(dir, 'actual.json');
  await writeFile(actual, JSON.stringify({ ...spec, children: [
    { type: 'text', name: 'Export', characters: 'Export 0', fontSize: 13 },
  ] }));
  const args = join(dir, 'args.json');
  await writeFile(args, JSON.stringify({ mockupSpecPath: path, appSpecPath: actual }));
  const cli = spawnSync(process.execPath,
    [join(import.meta.dirname, '..', 'mcp', 'bin', 'figbridge-mcp.js'), 'call', 'diff_specs', `@${args}`],
    { encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stderr);
  const report = JSON.parse(cli.stdout);
  assert(report.deltas.some((d) => d.field === 'characters' && d.a === 'Export 186' && d.b === 'Export 0'));
  assert(report.deltas.some((d) => d.field === 'fontSize' && d.a === 12 && d.b === 13));
  console.log('comparison input: 9 checks passed');
} finally {
  await rm(dir, { recursive: true, force: true });
}
