// dom-to-spec.js — runs INSIDE a browser context (chrome-devtools-mcp /
// puppeteer / Playwright evaluate). Walks the rendered DOM rooted at
// `rootSelector` (default 'body'), reads getComputedStyle() per element,
// and returns a JSON spec compatible with figbridge's `import_from_code`.
//
// Usage from chrome-devtools-mcp:
//   const spec = await page.evaluate(domToSpec, { rootSelector: 'body', viewport: 1280 });
//   curl POST /command { action: 'import-from-code', args: { spec } }
//
// Design notes:
// - Real computed styles (Tailwind / external CSS / inline all reconciled by the browser).
// - getBoundingClientRect() for rendered size, not declared CSS width.
// - Visibility filter: display:none / visibility:hidden / 0-size → dropped.
// - Mixed-content elements (text + child elements) keep their children;
//   the bare text is dropped to avoid double-rendering. Pure text leaves
//   ARE emitted.
// - Background images on a non-<img> are captured as a `bgImage` URL so
//   figbridge can fetch+embed them later (v2). For now they're noted in
//   a `_warn` field so we can see what's missing.
//
// Returns: a single root frame spec, with deeply nested children.

(function () {
  function rgbToHex(rgb) {
    if (!rgb || rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') return null;
    const m = rgb.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/);
    if (!m) return null;
    const a = m[4] != null ? parseFloat(m[4]) : 1;
    if (a === 0) return null;
    const hx = (n) => parseInt(n, 10).toString(16).padStart(2, '0');
    return '#' + hx(m[1]) + hx(m[2]) + hx(m[3]);
  }

  function px(v) {
    if (v == null) return null;
    const m = String(v).match(/(-?[\d.]+)/);
    return m ? Number(m[1]) : null;
  }

  function isVisible(el, cs) {
    // Important: do NOT skip elements with opacity:0. They're real DOM
    // (often pre-scroll fade-in targets) and we want their structure +
    // colors captured. Only skip when the element truly contributes
    // nothing — display:none, visibility:hidden, or zero-area.
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    return true;
  }

  function hasOnlyTextChildren(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 1) return false; // element child
    }
    return el.textContent && el.textContent.trim().length > 0;
  }

  function getTextValue(el) {
    return el.textContent.replace(/\s+/g, ' ').trim();
  }

  function pickLayout(cs) {
    if (cs.display.includes('flex')) {
      return cs.flexDirection && cs.flexDirection.startsWith('row') ? 'HORIZONTAL' : 'VERTICAL';
    }
    if (cs.display.includes('grid')) return 'VERTICAL'; // collapse grid to vertical for v1
    return 'NONE';
  }

  function padOf(cs) {
    // Emit per-side padding as an object — figbridge plugin reads either
    // { top, right, bottom, left } or a single number.
    const t = px(cs.paddingTop) || 0;
    const r = px(cs.paddingRight) || 0;
    const b = px(cs.paddingBottom) || 0;
    const l = px(cs.paddingLeft) || 0;
    if (t === 0 && r === 0 && b === 0 && l === 0) return 0;
    if (t === r && r === b && b === l) return t; // all equal → number form
    return { top: t, right: r, bottom: b, left: l };
  }

  // Pick the best fill: prefer linear-gradient if backgroundImage has one,
  // otherwise the solid backgroundColor. (Radial gradients are recognized
  // and noted in _bgImage for a future plugin pass.)
  function fillOf(cs) {
    const bgImage = cs.backgroundImage;
    if (bgImage && bgImage !== 'none') {
      const linear = bgImage.match(/^linear-gradient\([^)]*(?:\([^)]*\)[^)]*)*\)/i);
      if (linear) return linear[0];   // pass raw CSS string; plugin parses
    }
    return rgbToHex(cs.backgroundColor);
  }

  function radius(cs) {
    const v = px(cs.borderTopLeftRadius);
    return v || null;
  }

  function fontWeight(cs) {
    const w = parseInt(cs.fontWeight, 10);
    if (!w) return null;
    if (w >= 700) return 'Bold';
    if (w >= 600) return 'Semi Bold';
    if (w >= 500) return 'Medium';
    if (w <= 300) return 'Light';
    return 'Regular';
  }

  function nodeForElement(el, opts, depth) {
    const cs = window.getComputedStyle(el);
    if (!isVisible(el, cs)) return null;
    const tag = el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    const name = el.id ? `#${el.id}` : (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/)[0] : tag);

    // <img> → rect (image bytes inlined as data URL when embedImages opt is on).
    if (tag === 'img') {
      const fill = rgbToHex(cs.backgroundColor);
      const node = {
        type: 'rect',
        name: name + ':img',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        fill: fill || '#e2e8f0',
        cornerRadius: radius(cs),
        _src: el.getAttribute('src') || null,
      };
      if (opts.embedImages) {
        try {
          // Canvas-based capture works only for same-origin or
          // CORS-permitted images. Tainted canvas throws on toDataURL —
          // we catch and fall back to the plain rect.
          const c = document.createElement('canvas');
          c.width = Math.max(1, el.naturalWidth || Math.round(rect.width));
          c.height = Math.max(1, el.naturalHeight || Math.round(rect.height));
          const ctx = c.getContext('2d');
          ctx.drawImage(el, 0, 0, c.width, c.height);
          node._imageBytes = c.toDataURL('image/png');
        } catch (e) { /* CORS tainted — keep _src for server-side fetch v2 */ }
      }
      return node;
    }
    // <hr> / <svg> / empty placeholder
    if (tag === 'hr' || tag === 'svg') {
      return {
        type: 'rect',
        name: name + ':' + tag,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        fill: rgbToHex(cs.backgroundColor) || rgbToHex(cs.color) || '#94a3b8',
        cornerRadius: radius(cs),
      };
    }

    // Pure-text leaf → text node.
    if (hasOnlyTextChildren(el) && !['button', 'a'].includes(tag)) {
      // (buttons/links with text-only content are handled below as frame+text
      //  so we can preserve their background.)
      return {
        type: 'text',
        name: name,
        characters: getTextValue(el),
        fontSize: Math.round(px(cs.fontSize) || 16),
        fontWeight: fontWeight(cs),
        color: rgbToHex(cs.color),
      };
    }

    // Button/link with text content → frame containing a single text child.
    // Preserves background, padding, radius — closer to what designers expect.
    if ((tag === 'button' || tag === 'a') && hasOnlyTextChildren(el)) {
      const frame = {
        type: 'frame',
        name: name + ':' + tag,
        layout: 'HORIZONTAL',
        padding: padOf(cs),
        fill: fillOf(cs),
        cornerRadius: radius(cs),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        children: [{
          type: 'text',
          name: name + ':text',
          characters: getTextValue(el),
          fontSize: Math.round(px(cs.fontSize) || 14),
          fontWeight: fontWeight(cs),
          color: rgbToHex(cs.color),
        }],
      };
      return frame;
    }

    // Generic container → frame with auto-layout heuristic.
    const frame = {
      type: 'frame',
      name: name,
      layout: pickLayout(cs),
      padding: padOf(cs),
      spacing: px(cs.gap) || px(cs.rowGap) || 0,
      fill: fillOf(cs),
      cornerRadius: radius(cs),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      children: [],
    };

    // Background-image (e.g. hero gradient) — note it; we'll embed in v2.
    const bgImage = cs.backgroundImage;
    if (bgImage && bgImage !== 'none') frame._bgImage = bgImage;

    if (depth >= opts.maxDepth) return frame;

    for (const child of el.children) {
      const cn = nodeForElement(child, opts, depth + 1);
      if (cn) frame.children.push(cn);
    }

    // If a flex container has zero element children but has a text leaf,
    // emit a text node too (some sites stuff text directly into a flex row).
    if (frame.children.length === 0 && el.textContent.trim()) {
      frame.children.push({
        type: 'text',
        name: name + ':inline',
        characters: getTextValue(el),
        fontSize: Math.round(px(cs.fontSize) || 16),
        fontWeight: fontWeight(cs),
        color: rgbToHex(cs.color),
      });
    }

    return frame;
  }

  /**
   * @param {{ rootSelector?: string, maxDepth?: number, viewport?: number, name?: string }} opts
   * @returns {object} figbridge spec
   */
  window.domToSpec = function (opts) {
    opts = opts || {};
    const rootSelector = opts.rootSelector || 'body';
    const maxDepth = opts.maxDepth || 30;
    const embedImages = !!opts.embedImages;
    const root = document.querySelector(rootSelector);
    if (!root) throw new Error('rootSelector not found: ' + rootSelector);
    const spec = nodeForElement(root, { maxDepth, embedImages }, 0);
    if (spec) {
      spec.name = opts.name || (document.title || 'Imported page');
      // Force the root to the viewport width for clean side-by-side layout.
      if (opts.viewport) spec.width = opts.viewport;
    }
    return spec;
  };
})();
