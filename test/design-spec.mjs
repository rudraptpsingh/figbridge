import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const code = fs.readFileSync(path.join(root, 'plugin', 'code.js'), 'utf8');
const block = code.match(/\/\/ BEGIN FIGBRIDGE DESIGN SPEC([\s\S]*?)\/\/ END FIGBRIDGE DESIGN SPEC/);
if (!block) throw new Error('design spec exporter missing');

const figmaRoot = {
  id: '1:1', type: 'FRAME', name: 'Loupe', width: 1440, height: 900,
  visible: true, absoluteBoundingBox: { x: 100, y: 200, width: 1440, height: 900 },
  fills: [{ type: 'SOLID', visible: true, color: { r: 0.1, g: 0.2, b: 0.3 }, opacity: 1 }],
  opacity: 1,
  strokes: [{ type: 'SOLID', visible: true, color: { r: 1, g: 1, b: 1 }, opacity: 0.10000000149011612 }],
  strokeWeight: 1,
  layoutMode: 'VERTICAL', paddingTop: 8, paddingRight: 12, paddingBottom: 8,
  paddingLeft: 12, itemSpacing: 4, cornerRadius: 0,
  children: [
    { id: '1:2', type: 'TEXT', name: 'Title', width: 100, height: 22,
      visible: true, absoluteBoundingBox: { x: 124, y: 230, width: 100, height: 22 },
      characters: 'Reception', fontName: { family: 'Inter', style: 'Semi Bold' },
      fontWeight: 600, fontSize: 15, lineHeight: { unit: 'PIXELS', value: 22 },
      letterSpacing: { unit: 'PIXELS', value: 0 },
      fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 1, b: 1 }, opacity: 1 }] },
    { id: '1:3', type: 'FRAME', name: 'hidden', visible: false,
      children: [{ id: '1:4', type: 'TEXT', name: 'secret', visible: true }] },
    { id: '1:5', type: 'INSTANCE', name: 'photo', width: 300, height: 200,
      visible: true, absoluteBoundingBox: { x: 200, y: 300, width: 300, height: 200 },
      componentProperties: { State: { type: 'VARIANT', value: 'On' } },
      fills: [{ type: 'IMAGE', visible: true, imageHash: 'abc' }] },
  ],
};
const sandbox = {
  figma: { mixed: Symbol('mixed'), fileKey: 'file-key', getNodeByIdAsync: async id => id === '1:1' ? figmaRoot : null },
};
vm.createContext(sandbox);
vm.runInContext(block[1] + '\nthis.exportDesignSpec = exportDesignSpec;', sandbox);
const result = await sandbox.exportDesignSpec('1:1');
if (!result.ok) throw new Error(JSON.stringify(result));
const { spec, capture } = result;
function assert(yes, message) { if (!yes) throw new Error(message + ': ' + JSON.stringify(result)); }
assert(spec._figmaId === '1:1' && spec._rect.x === 0 && spec._rect.y === 0, 'root identity and viewport origin');
assert(spec.fill[0].color === '#1a334d' && spec.padding.top === 8 && spec.spacing === 4, 'paint and layout values');
assert(!Object.hasOwn(spec, 'opacity') && spec.stroke.alpha === 0.1, 'default opacity omitted and paint alpha normalized');
assert(spec.children.length === 2 && capture.hiddenSubtrees === 1, 'hidden subtree omitted');
assert(spec.children[0]._rect.x === 24 && spec.children[0]._rect.y === 30, 'absolute design bounds normalized to frame');
assert(spec.children[0].characters === 'Reception' && spec.children[0].fontFamily === 'Inter' &&
  spec.children[0].fontWeight === 600 && spec.children[0].lineHeight === 22, 'authored text values');
assert(spec.children[0].color === '#ffffff' && !Object.hasOwn(spec.children[0], 'fill'),
  'text paint must use the same color field as rendered DOM text');
assert(capture.visibleNodes === 3 && capture.warnings.some(w => w.nodeId === '1:5' && w.field === 'fills'),
  'unsupported image paint disclosed');
assert(spec.children[1]._state === 'on' && spec.children[1]._figmaProps.State.value === 'On',
  'variant state must be captured for matched-state review');
console.log('PASS  design spec export (9 assertions).');
