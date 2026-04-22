// Shared test fixtures — synthetic Figma node trees.
function frame(overrides) {
  return Object.assign({
    id: "1:1",
    name: "Frame",
    type: "FRAME",
    x: 0, y: 0, width: 200, height: 100,
    opacity: 1,
    visible: true,
    clipsContent: false,
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 1 }],
    strokes: [],
    effects: [],
    cornerRadius: 8,
    layoutMode: "NONE",
    children: [],
  }, overrides || {});
}

function text(overrides) {
  return Object.assign({
    id: "2:1",
    name: "Copy",
    type: "TEXT",
    x: 16, y: 16, width: 100, height: 20,
    opacity: 1,
    visible: true,
    characters: "Hello",
    fontName: { family: "Inter", style: "Bold" },
    fontSize: 16,
    lineHeight: { unit: "AUTO" },
    letterSpacing: { unit: "PIXELS", value: 0 },
    textAlignHorizontal: "LEFT",
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    strokes: [],
    effects: [],
    textDecoration: "NONE",
  }, overrides || {});
}

function autoLayout(overrides) {
  return frame(Object.assign({
    layoutMode: "HORIZONTAL",
    primaryAxisAlignItems: "CENTER",
    counterAxisAlignItems: "CENTER",
    itemSpacing: 8,
    paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8,
  }, overrides || {}));
}

module.exports = { frame, text, autoLayout };
