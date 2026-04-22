// Minimal Figma API stub so code.js can be required in Node.
const MIXED = Symbol("figma.mixed");

global.__html__ = "<html></html>";
global.figma = {
  mixed: MIXED,
  showUI: () => {},
  on: () => {},
  root: { children: [] },
  ui: { postMessage: () => {} },
  currentPage: { selection: [], name: "Test" },
  setCurrentPageAsync: async () => {},
  loadAllPagesAsync: async () => {},
  closePlugin: () => {},
  getNodeByIdAsync: async () => null,
  variables: {
    getLocalVariablesAsync: async () => [],
    getLocalVariableCollectionsAsync: async () => [],
    getVariableByIdAsync: async () => null,
  },
};

module.exports = { MIXED };
