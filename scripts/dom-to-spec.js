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

  // Headings / paragraphs / buttons frequently contain inline spans
  // (highlight rules, masks, em). The leading direct-text-node would
  // otherwise be dropped. Returns true if the element is a known
  // "text-y" tag and ALL nested content is text-like (no images, no
  // block children, no svg).
  function isInlineText(el) {
    const tag = el.tagName.toLowerCase();
    if (!['h1','h2','h3','h4','h5','h6','p','a','button','label','strong','em','span','blockquote'].includes(tag)) return false;
    // Only true blockers: nested block-level wrappers, img, video, iframe,
    // canvas, picture. SVGs inside headings are typically decorative
    // (underline accents, dot marks) — getting the text in matters more.
    for (const n of el.querySelectorAll('img,video,canvas,iframe,picture,hr')) return false;
    for (const n of el.querySelectorAll('section,header,footer,article,aside,main,div')) {
      if (n.children.length > 0) return false;
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
    return 'NONE';
  }

  function flexWrapOf(cs) {
    if (!cs.display.includes('flex')) return null;
    const w = cs.flexWrap;
    return (w === 'wrap' || w === 'wrap-reverse') ? 'WRAP' : null;
  }

  function whiteSpaceOf(cs) {
    return (cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre') ? 'NOWRAP' : null;
  }

  function minMaxOf(cs) {
    const out = {};
    const mw = px(cs.minWidth), MW = px(cs.maxWidth);
    const mh = px(cs.minHeight), MH = px(cs.maxHeight);
    if (mw && mw > 0) out.minWidth = mw;
    if (MW && MW < 100000) out.maxWidth = MW;
    if (mh && mh > 0) out.minHeight = mh;
    if (MH && MH < 100000) out.maxHeight = MH;
    return Object.keys(out).length ? out : null;
  }

  // text-shadow: extracts the first non-zero shadow as a Figma drop-shadow
  // on the text node. Same shape as box-shadow shadowOf().
  function textShadowOf(cs) {
    const t = cs.textShadow;
    if (!t || t === 'none') return null;
    // Reuse the box-shadow parser by aliasing into a fake CS-like object.
    return shadowOf({ boxShadow: t });
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

  // Emit per-corner radius as { tl, tr, br, bl } when asymmetric, single
  // number when uniform. Pill-style buttons often have only top corners.
  function radius(cs) {
    const tl = px(cs.borderTopLeftRadius) || 0;
    const tr = px(cs.borderTopRightRadius) || 0;
    const br = px(cs.borderBottomRightRadius) || 0;
    const bl = px(cs.borderBottomLeftRadius) || 0;
    if (tl === 0 && tr === 0 && br === 0 && bl === 0) return null;
    if (tl === tr && tr === br && br === bl) return tl;
    return { tl, tr, br, bl };
  }

  // CSS transform matrix(a, b, c, d, tx, ty) — extract translate + rotate.
  // For simple translate/scale/rotate this round-trips to Figma cleanly.
  function transformOf(cs) {
    const t = cs.transform;
    if (!t || t === 'none') return null;
    // matrix(a, b, c, d, tx, ty)
    const m = t.match(/^matrix\(([^)]+)\)$/);
    if (m) {
      const [a, b, c, d, tx, ty] = m[1].split(',').map(s => parseFloat(s.trim()));
      const rotateRad = Math.atan2(b, a);
      const scaleX = Math.sqrt(a * a + b * b);
      const scaleY = Math.sqrt(c * c + d * d);
      // Skip identity matrices
      if (Math.abs(tx) < 0.5 && Math.abs(ty) < 0.5 && Math.abs(rotateRad) < 0.01 && Math.abs(scaleX - 1) < 0.01 && Math.abs(scaleY - 1) < 0.01) return null;
      return {
        translateX: Math.round(tx),
        translateY: Math.round(ty),
        rotation: Math.round(rotateRad * 180 / Math.PI * 100) / 100,
        scaleX: Math.round(scaleX * 1000) / 1000,
        scaleY: Math.round(scaleY * 1000) / 1000,
      };
    }
    return null;
  }

  // backdrop-filter: blur(Npx) — common for glassy nav bars / form cards.
  function backdropBlurOf(cs) {
    const f = cs.backdropFilter || cs.webkitBackdropFilter;
    if (!f || f === 'none') return null;
    const m = f.match(/blur\(([\d.]+)px\)/);
    return m ? parseFloat(m[1]) : null;
  }

  // CSS outline — used for focus rings / accent edges, distinct from border.
  function outlineOf(cs) {
    const w = px(cs.outlineWidth) || 0;
    if (w === 0 || cs.outlineStyle === 'none') return null;
    const color = rgbToHex(cs.outlineColor);
    if (!color) return null;
    return { color, width: w };
  }

  // Stacking context: prefer explicit z-index, else position-aware tiebreak.
  function zIndexOf(cs) {
    const z = parseInt(cs.zIndex, 10);
    return isFinite(z) ? z : null;
  }

  // 1px borders are common on cards/buttons — extract width + color.
  function strokeOf(cs) {
    const w = px(cs.borderTopWidth) || 0;
    if (w === 0 || cs.borderTopStyle === 'none') return null;
    const c = rgbToHex(cs.borderTopColor);
    if (!c) return null;
    return { color: c, width: w };
  }

  // Parse a single CSS box-shadow into { x, y, blur, spread, color, inset }.
  // Multi-shadow strings (comma-separated) → take the first non-inset visible
  // one for Figma DROP_SHADOW. Insets are noted but Figma's INNER_SHADOW
  // matches them in the plugin.
  function shadowOf(cs) {
    const raw = cs.boxShadow;
    if (!raw || raw === 'none') return null;
    // Split on commas not inside parens (rgba() etc.)
    const parts = []; let depth = 0; let buf = '';
    for (const ch of raw) {
      if (ch === '(') depth++; else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; }
      else buf += ch;
    }
    if (buf.trim()) parts.push(buf.trim());
    const out = [];
    for (const p of parts) {
      const inset = /\binset\b/.test(p);
      const cm = p.match(/(rgba?\([^)]+\)|#[0-9a-f]+|[a-z]+)/i);
      if (!cm) continue;
      const colorRaw = cm[0];
      const color = rgbToHex(colorRaw);
      if (!color) continue;
      const after = p.replace(colorRaw, '').replace(/\binset\b/, '').trim();
      const nums = (after.match(/-?[\d.]+px/g) || []).map(s => parseFloat(s));
      if (nums.length < 2) continue;
      out.push({
        x: nums[0] || 0,
        y: nums[1] || 0,
        blur: nums[2] || 0,
        spread: nums[3] || 0,
        color,
        inset,
      });
    }
    return out.length ? out : null;
  }

  function textAlignOf(cs) {
    const v = cs.textAlign;
    if (v === 'left' || v === 'start') return 'LEFT';
    if (v === 'right' || v === 'end') return 'RIGHT';
    if (v === 'center') return 'CENTER';
    if (v === 'justify') return 'JUSTIFIED';
    return null;
  }

  function fontFamilyOf(cs) {
    return cs.fontFamily.split(',')[0].trim().replace(/['"]/g, '');
  }

  function lineHeightOf(cs) {
    const v = parseFloat(cs.lineHeight);
    if (!isFinite(v)) return null;
    return Math.round(v);
  }

  function opacityOf(cs) {
    const v = parseFloat(cs.opacity);
    return (isFinite(v) && v < 1) ? v : null;
  }

  function letterSpacingOf(cs) {
    const v = parseFloat(cs.letterSpacing);
    if (!isFinite(v) || v === 0) return null;
    return v;
  }

  function textDecorationOf(cs) {
    const line = cs.textDecorationLine || cs.textDecoration || '';
    if (line.includes('underline')) return 'UNDERLINE';
    if (line.includes('line-through')) return 'STRIKETHROUGH';
    return null;
  }

  function textTransformOf(cs) {
    const t = cs.textTransform;
    if (t === 'uppercase') return 'UPPER';
    if (t === 'lowercase') return 'LOWER';
    if (t === 'capitalize') return 'TITLE';
    return null;
  }

  // Walk the text-leaf-or-inline element and collect [start, end) ranges
  // for each text-node child whose computed style differs from the parent.
  // Emitted per-range overrides drive the plugin's setRange*() APIs.
  function collectStyleRanges(el, parentCs) {
    const out = [];
    const parentColor = rgbToHex(parentCs.color);
    const parentSize = Math.round(px(parentCs.fontSize) || 16);
    const parentWeight = parseInt(parentCs.fontWeight, 10) || 400;
    const parentDecoration = textDecorationOf(parentCs);
    let cursor = 0;
    function visit(node, contextEl) {
      if (node.nodeType === 3) { // text
        const len = String(node.textContent).replace(/\s+/g, ' ').trim().length;
        if (len === 0) return;
        const cs = window.getComputedStyle(contextEl);
        const color = rgbToHex(cs.color);
        const size = Math.round(px(cs.fontSize) || 16);
        const weight = parseInt(cs.fontWeight, 10) || 400;
        const decoration = textDecorationOf(cs);
        const differs = (color && color !== parentColor) || size !== parentSize || weight !== parentWeight || decoration !== parentDecoration;
        if (differs) {
          out.push({
            start: cursor,
            end: cursor + len,
            color: color !== parentColor ? color : undefined,
            fontSize: size !== parentSize ? size : undefined,
            fontWeight: weight !== parentWeight ? fontWeightLabel(weight) : undefined,
            textDecoration: decoration !== parentDecoration ? decoration : undefined,
          });
        }
        cursor += len + 1; // +1 for the implicit space the joiner adds between nodes
        return;
      }
      if (node.nodeType !== 1) return;
      for (const c of node.childNodes) visit(c, node.nodeType === 1 ? node : contextEl);
    }
    // Reset cursor by recomputing from the canonical getTextValue() length
    // to keep indices stable.
    cursor = 0;
    for (const c of el.childNodes) visit(c, el);
    return out;
  }

  function fontWeightLabel(n) {
    if (n >= 700) return 'Bold';
    if (n >= 600) return 'Semi Bold';
    if (n >= 500) return 'Medium';
    if (n <= 300) return 'Light';
    return 'Regular';
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
    // <iframe> → rect with index tag so the server-side orchestrator
    // can fill it in with a puppeteer-captured screenshot of that iframe.
    if (tag === 'iframe') {
      // Compute the iframe's index in document order; matches what the
      // server's page.$$('iframe') will return.
      const all = Array.from(document.querySelectorAll('iframe'));
      const idx = all.indexOf(el);
      return {
        type: 'rect',
        name: name + ':iframe',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        fill: rgbToHex(cs.backgroundColor) || '#e2e8f0',
        cornerRadius: radius(cs),
        _iframeIdx: idx,
        _src: el.getAttribute('src') || null,
      };
    }
    // <svg> → carry the outerHTML so the plugin can do
    // figma.createNodeFromSvg() and produce real vector layers.
    if (tag === 'svg') {
      // Set fill on the svg element if missing so currentColor renders.
      // We capture the source as-is; the plugin will pre-pass currentColor.
      const node = {
        type: 'svg',
        name: name + ':svg',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        _svg: el.outerHTML,
        _color: rgbToHex(cs.color),
      };
      return node;
    }
    // <hr> → thin colored line
    if (tag === 'hr') {
      return {
        type: 'rect',
        name: name + ':hr',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        fill: rgbToHex(cs.backgroundColor) || rgbToHex(cs.color) || '#94a3b8',
        cornerRadius: radius(cs),
      };
    }

    // Text leaf — either pure-text or "inline-text" (heading/p/span with
    // nested inline spans but no block-level or media children). The
    // inline-text path catches `<h1>Sort. <span>Tag.</span> Deliver.</h1>`
    // where the leading direct-text-node would otherwise be dropped.
    if ((hasOnlyTextChildren(el) || isInlineText(el)) && !['button', 'a'].includes(tag)) {
      const ranges = collectStyleRanges(el, cs);
      return {
        type: 'text',
        name: name,
        characters: getTextValue(el),
        fontSize: Math.round(px(cs.fontSize) || 16),
        fontWeight: fontWeight(cs),
        fontFamily: fontFamilyOf(cs),
        lineHeight: lineHeightOf(cs),
        letterSpacing: letterSpacingOf(cs),
        textAlign: textAlignOf(cs),
        textDecoration: textDecorationOf(cs),
        textTransform: textTransformOf(cs),
        whiteSpace: whiteSpaceOf(cs),
        textShadow: textShadowOf(cs),
        color: rgbToHex(cs.color),
        opacity: opacityOf(cs),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        ranges: ranges.length ? ranges : undefined,
      };
    }

    // Button/link with text content → frame containing a single text child.
    if ((tag === 'button' || tag === 'a') && (hasOnlyTextChildren(el) || isInlineText(el))) {
      const frame = {
        type: 'frame',
        name: name + ':' + tag,
        layout: 'HORIZONTAL',
        padding: padOf(cs),
        fill: fillOf(cs),
        cornerRadius: radius(cs),
        stroke: strokeOf(cs),
        outline: outlineOf(cs),
        shadow: shadowOf(cs),
        opacity: opacityOf(cs),
        transform: transformOf(cs),
        backdropBlur: backdropBlurOf(cs),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        children: [{
          type: 'text',
          name: name + ':text',
          characters: getTextValue(el),
          fontSize: Math.round(px(cs.fontSize) || 14),
          fontWeight: fontWeight(cs),
          fontFamily: fontFamilyOf(cs),
          lineHeight: lineHeightOf(cs),
          textAlign: textAlignOf(cs),
          color: rgbToHex(cs.color),
        }],
      };
      return frame;
    }

    // Generic container → frame with auto-layout heuristic.
    const mm = minMaxOf(cs);
    const frame = {
      type: 'frame',
      name: name,
      layout: pickLayout(cs),
      layoutWrap: flexWrapOf(cs),
      padding: padOf(cs),
      spacing: px(cs.gap) || px(cs.rowGap) || 0,
      fill: fillOf(cs),
      cornerRadius: radius(cs),
      stroke: strokeOf(cs),
      outline: outlineOf(cs),
      shadow: shadowOf(cs),
      opacity: opacityOf(cs),
      transform: transformOf(cs),
      backdropBlur: backdropBlurOf(cs),
      zIndex: zIndexOf(cs),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      minWidth: mm && mm.minWidth,
      maxWidth: mm && mm.maxWidth,
      minHeight: mm && mm.minHeight,
      maxHeight: mm && mm.maxHeight,
      children: [],
    };

    // Background-image — capture url(...) targets so the server can fetch
    // + inline them. Also keep the raw CSS for any layered gradient that
    // the fillOf() helper didn't extract as the primary fill.
    const bgImage = cs.backgroundImage;
    if (bgImage && bgImage !== 'none') {
      frame._bgImage = bgImage;
      const urlMatch = bgImage.match(/url\(['"]?([^'")]+)['"]?\)/);
      if (urlMatch) {
        const u = urlMatch[1];
        // Resolve to absolute URL for the server to fetch.
        frame._bgUrl = (new URL(u, document.baseURI)).href;
      }
    }

    if (depth >= opts.maxDepth) return frame;

    // Capture parent rect once so we can emit per-child relative offsets
    // when the parent is *not* an auto-layout container. Without these,
    // children would all land at (0,0) inside a NONE-layout frame and
    // visually pile up on top of each other.
    const parentRect = rect;
    const isAutoLayout = frame.layout === 'VERTICAL' || frame.layout === 'HORIZONTAL';

    // CSS pseudo-elements (::before / ::after). Approximate placement
    // from computed CSS: respect position (absolute uses top/right/bottom/
    // left), and account for translate offsets in the pseudo's transform.
    for (const side of ['::before', '::after']) {
      const ps = window.getComputedStyle(el, side);
      const content = ps.content;
      if (!content || content === 'none' || content === 'normal') continue;
      const isAfter = side === '::after';
      const fontSizeNum = px(ps.fontSize) || 14;
      const w = px(ps.width) || px(ps.minWidth) || fontSizeNum;
      const h = px(ps.height) || px(ps.minHeight) || fontSizeNum;

      const textMatch = content.match(/^['"](.*)['"]$/);
      let pseudoNode;
      if (textMatch && textMatch[1]) {
        pseudoNode = {
          type: 'text',
          name: name + side,
          characters: textMatch[1],
          fontSize: Math.round(fontSizeNum),
          fontWeight: fontWeight(ps),
          color: rgbToHex(ps.color),
        };
      } else {
        pseudoNode = {
          type: 'rect',
          name: name + side,
          width: Math.round(w),
          height: Math.round(h),
          fill: fillOf(ps),
          cornerRadius: radius(ps),
          stroke: strokeOf(ps),
          shadow: shadowOf(ps),
        };
      }
      if (!isAutoLayout) {
        // Anchor: ::before at element start, ::after at element end.
        // Account for absolute positioning offsets when set.
        let baseX = isAfter ? rect.right - w : rect.left;
        let baseY = rect.top + (rect.height - h) / 2;
        if (ps.position === 'absolute') {
          // top/left override the anchor; right/bottom go the other way.
          const top = px(ps.top), left = px(ps.left), right = px(ps.right), bottom = px(ps.bottom);
          if (top != null) baseY = rect.top + top;
          else if (bottom != null) baseY = rect.bottom - bottom - h;
          if (left != null) baseX = rect.left + left;
          else if (right != null) baseX = rect.right - right - w;
        }
        // Apply transform translate (the matrix tx/ty).
        const tr = transformOf(ps);
        if (tr) { baseX += tr.translateX || 0; baseY += tr.translateY || 0; }
        pseudoNode.x = Math.round(baseX - parentRect.left);
        pseudoNode.y = Math.round(baseY - parentRect.top);
      }
      frame.children.push(pseudoNode);
    }

    // Build the child list, capturing each child's computed z-index for
    // the final ordering pass (so overlay elements render on top).
    const draft = [];
    for (const child of el.children) {
      const cn = nodeForElement(child, opts, depth + 1);
      if (!cn) continue;
      if (!isAutoLayout) {
        const cr = child.getBoundingClientRect();
        cn.x = Math.round(cr.left - parentRect.left);
        cn.y = Math.round(cr.top - parentRect.top);
      }
      const childCs = window.getComputedStyle(child);
      const zi = parseInt(childCs.zIndex, 10);
      draft.push({ node: cn, z: isFinite(zi) ? zi : 0, idx: draft.length });
    }
    // Stable sort: by z ascending (low z first → rendered behind), then by
    // DOM order. Figma appends-on-top, so this matches the browser's
    // painter's order for the simple cases.
    if (!isAutoLayout && draft.length > 1) {
      draft.sort((a, b) => (a.z - b.z) || (a.idx - b.idx));
    }
    for (const d of draft) frame.children.push(d.node);

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
