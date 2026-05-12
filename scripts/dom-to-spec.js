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
    // getComputedStyle() resolves modern color formats (hsla, oklch, lab,
    // color()) into rgb()/rgba() syntax — so this single matcher catches
    // every color-space the browser supports. No special-casing needed.
    const m = rgb.match(/rgba?\(\s*([\d.]+)\s*,?\s*([\d.]+)\s*,?\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?/);
    if (!m) return null;
    let a = 1;
    if (m[4] != null) {
      a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    }
    if (a === 0) return null;
    const hx = (n) => Math.round(parseFloat(n)).toString(16).padStart(2, '0');
    return '#' + hx(m[1]) + hx(m[2]) + hx(m[3]);
  }

  function px(v) {
    if (v == null) return null;
    const m = String(v).match(/(-?[\d.]+)/);
    return m ? Number(m[1]) : null;
  }

  // Designer-friendly node names. Prefer id, then a semantic-tag label,
  // then the first non-utility class, finally the tag. Utility classes
  // (Tailwind-style: ".max-w-6xl", ".text-[15px]") are noisy in Figma's
  // Layers panel.
  const SEMANTIC_NAMES = {
    header: 'Header', footer: 'Footer', nav: 'Nav', main: 'Main',
    section: 'Section', article: 'Article', aside: 'Aside',
    h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4',
    h5: 'Heading 5', h6: 'Heading 6',
    p: 'Paragraph', a: 'Link', button: 'Button', img: 'Image', svg: 'Icon',
    ul: 'List', ol: 'List', li: 'List item',
    form: 'Form', input: 'Input', textarea: 'Textarea', label: 'Label',
    figure: 'Figure', figcaption: 'Caption', blockquote: 'Quote',
  };
  function looksUtility(cls) {
    // Tailwind utility classes: prefixes, brackets, slashes, colons.
    return /^(p|m|mt|mb|ml|mr|mx|my|w|h|min-|max-|text-|bg-|flex|grid|gap-|items-|justify-|space-|rounded|shadow|opacity|hover:|focus:|md:|lg:|sm:)/.test(cls)
      || /\[/.test(cls) || /\//.test(cls);
  }
  function firstSemanticClass(className) {
    if (typeof className !== 'string' || !className) return null;
    const all = className.split(/\s+/).filter(Boolean);
    for (const c of all) if (!looksUtility(c)) return c;
    return null;
  }
  // Structural signature used for component detection. Two sibling DOM
  // elements with the same signature are treated as repetitions of the
  // same component (e.g. 5 workflow rows, 4 footer columns, 6 FAQ items).
  // Conservative: requires matching tag + first non-utility class + same
  // child-tag count vector. Tighter than the browser's :nth-of-type but
  // looser than full DOM-tree-hash; lets us componentize meaningful
  // repetitions without grouping unrelated siblings.
  function childSignature(el) {
    if (!(el instanceof Element)) return null;
    const tag = el.tagName.toLowerCase();
    const cls = firstSemanticClass(el.className);
    if (!cls) return null; // No semantic class → don't group (safer default).
    // Count children by tag for a coarse-but-effective structural match.
    const tagCounts = {};
    for (const c of el.children) {
      const t = c.tagName.toLowerCase();
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
    const tagFingerprint = Object.keys(tagCounts).sort().map(t => t + tagCounts[t]).join(',');
    return tag + '|' + cls + '|' + tagFingerprint;
  }

  function nameForNode(el, tag) {
    if (el.id) return '#' + el.id;
    // For text-y tags, snip the first words of textContent so layer
    // names read like "Heading 1: Sort. Tag. Deliver..." instead of
    // just "Heading 1". Way more navigable in Figma's Layers panel.
    if (['h1','h2','h3','h4','h5','h6','p','blockquote','figcaption','button'].includes(tag)) {
      const tc = (el.textContent || '').trim().slice(0, 40);
      if (tc) return (SEMANTIC_NAMES[tag] || tag) + ': ' + tc + (tc.length === 40 ? '…' : '');
    }
    const sc = firstSemanticClass(el.className);
    if (sc) return '.' + sc.slice(0, 32);
    if (SEMANTIC_NAMES[tag]) return SEMANTIC_NAMES[tag];
    return tag;
  }

  // Extract CSS custom properties (`--*`) from :root for design-system
  // handoff. These become Figma Variables on the plugin side.
  function collectCssVariables() {
    const out = {};
    const rootStyle = window.getComputedStyle(document.documentElement);
    // getComputedStyle includes inherited + cascaded properties; walk all.
    for (let i = 0; i < rootStyle.length; i++) {
      const prop = rootStyle.item(i);
      if (!prop.startsWith('--')) continue;
      const val = rootStyle.getPropertyValue(prop).trim();
      if (!val) continue;
      out[prop] = val;
    }
    return out;
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
  const INLINE_TEXT_TAGS = new Set(['h1','h2','h3','h4','h5','h6','p','a','button','label','strong','em','span','blockquote']);
  const BLOCK_TAGS = new Set(['section','header','footer','article','aside','main','div']);
  const MEDIA_TAGS = new Set(['img','video','canvas','iframe','picture','hr']);

  function isInlineText(el) {
    const tag = el.tagName.toLowerCase();
    if (!INLINE_TEXT_TAGS.has(tag)) return false;
    // Iterative scan instead of two querySelectorAll() calls. Same answer,
    // ~3-5× faster on big trees because we short-circuit and don't allocate.
    const stack = [el];
    while (stack.length) {
      const n = stack.pop();
      for (const c of n.children) {
        const ctag = c.tagName.toLowerCase();
        if (MEDIA_TAGS.has(ctag)) return false;
        if (BLOCK_TAGS.has(ctag) && c.children.length > 0) return false;
        if (c.children.length) stack.push(c);
      }
    }
    return el.textContent && el.textContent.trim().length > 0;
  }

  function getTextValue(el) {
    return el.textContent.replace(/\s+/g, ' ').trim();
  }

  // Flex/grid alignment → Figma auto-layout primary/counter-axis alignment.
  // CSS values map to Figma's enum values. justify-content maps to
  // primary-axis alignment; align-items to counter-axis alignment.
  function primaryAxisAlignOf(cs) {
    if (!cs.display.includes('flex') && !cs.display.includes('grid')) return null;
    const v = cs.justifyContent;
    if (v === 'flex-start' || v === 'start' || v === 'left') return 'MIN';
    if (v === 'flex-end' || v === 'end' || v === 'right') return 'MAX';
    if (v === 'center') return 'CENTER';
    if (v === 'space-between') return 'SPACE_BETWEEN';
    return null;
  }
  function counterAxisAlignOf(cs) {
    if (!cs.display.includes('flex') && !cs.display.includes('grid')) return null;
    const v = cs.alignItems;
    if (v === 'flex-start' || v === 'start') return 'MIN';
    if (v === 'flex-end' || v === 'end') return 'MAX';
    if (v === 'center') return 'CENTER';
    if (v === 'baseline') return 'BASELINE';
    if (v === 'stretch') return 'MIN'; // Figma stretches via FILL on children
    return null;
  }

  // text-overflow: ellipsis → text truncation. Captured for the plugin
  // to set textTruncation on the text node.
  function textTruncationOf(cs) {
    return cs.textOverflow === 'ellipsis' ? 'ENDING' : null;
  }

  // Child sizing strategy: flex:1 / flex-grow:1 → FILL the container.
  // Otherwise FIXED at the measured rect (default).
  function layoutGrowOf(cs) {
    const fg = parseFloat(cs.flexGrow);
    return isFinite(fg) && fg > 0 ? 1 : 0;
  }

  function pickLayout(cs) {
    if (cs.display.includes('flex')) {
      return cs.flexDirection && cs.flexDirection.startsWith('row') ? 'HORIZONTAL' : 'VERTICAL';
    }
    // CSS Grid — approximate as a wrapping HORIZONTAL row. Most page-level
    // grids on real sites are card-grids (4 columns, wrap to 2 / 1 on
    // narrower viewports) — that's HORIZONTAL + WRAP in Figma's auto-
    // layout. When the grid is single-row by computed track count, the
    // result is identical to a flex row. When it's multi-row, wrap kicks
    // in. (Per-child x/y still applies on the parent if non-auto-layout.)
    if (cs.display.includes('grid')) return 'HORIZONTAL';
    return 'NONE';
  }

  function flexWrapOf(cs) {
    // Flex wrap OR grid both go through Figma's WRAP since multi-row grids
    // need the same behavior.
    if (cs.display.includes('grid')) return 'WRAP';
    if (!cs.display.includes('flex')) return null;
    const w = cs.flexWrap;
    return (w === 'wrap' || w === 'wrap-reverse') ? 'WRAP' : null;
  }

  // CSS filter — blur(), grayscale(), drop-shadow(). Map to Figma effects.
  // Returns an array of LAYER_BLUR / DROP_SHADOW / null effects.
  function filterEffectsOf(cs) {
    const raw = cs.filter;
    if (!raw || raw === 'none') return null;
    const effects = [];
    // Tokenize on ) — each filter function ends in ).
    const fns = raw.match(/[a-z-]+\([^)]*\)/gi) || [];
    for (const fn of fns) {
      const m = fn.match(/^([a-z-]+)\((.*)\)$/i);
      if (!m) continue;
      const name = m[1].toLowerCase();
      const arg = m[2];
      if (name === 'blur') {
        const px = parseFloat(arg) || 0;
        if (px > 0) effects.push({ type: 'LAYER_BLUR', radius: px });
      } else if (name === 'drop-shadow') {
        // drop-shadow(x y blur color) — same shape as a single box-shadow.
        const shadow = shadowOf({ boxShadow: arg });
        if (shadow && shadow[0]) effects.push({
          type: 'DROP_SHADOW',
          x: shadow[0].x, y: shadow[0].y, blur: shadow[0].blur, spread: shadow[0].spread, color: shadow[0].color, inset: false,
        });
      }
      // grayscale/sepia/brightness/contrast/saturate/invert/hue-rotate: skip
      // for now — Figma doesn't have direct equivalents and faking them
      // would require image compositing which we don't want to bake in.
    }
    return effects.length ? effects : null;
  }

  // mix-blend-mode → Figma blendMode. Most common values map 1:1.
  const BLEND_MAP = {
    normal: 'NORMAL', multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY',
    darken: 'DARKEN', lighten: 'LIGHTEN', 'color-dodge': 'COLOR_DODGE',
    'color-burn': 'COLOR_BURN', 'hard-light': 'HARD_LIGHT',
    'soft-light': 'SOFT_LIGHT', difference: 'DIFFERENCE', exclusion: 'EXCLUSION',
    hue: 'HUE', saturation: 'SATURATION', color: 'COLOR', luminosity: 'LUMINOSITY',
  };
  function blendModeOf(cs) {
    const v = cs.mixBlendMode;
    if (!v || v === 'normal') return null;
    return BLEND_MAP[v] || null;
  }

  function whiteSpaceOf(cs) {
    return (cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre') ? 'NOWRAP' : null;
  }

  // Multi-line text truncation: -webkit-line-clamp limits visible lines.
  // We capture the line count so the plugin can resize the text node to
  // (lineHeight * count) and clip overflow.
  function lineClampOf(cs) {
    const n = parseInt(cs.webkitLineClamp || cs.lineClamp, 10);
    return isFinite(n) && n > 0 ? n : null;
  }

  // CSS aspect-ratio: 16/9 etc — capture for image/box sizing.
  // background-position / background-size affect how an image fill is
  // cropped/scaled inside its container. Mapped on the plugin side to
  // Figma's image-fill matrix.
  function bgScaleOf(cs) {
    const size = cs.backgroundSize;
    if (size === 'cover') return 'FILL';
    if (size === 'contain') return 'FIT';
    return null;
  }
  function bgPosOf(cs) {
    const pos = cs.backgroundPosition;
    if (!pos || pos === '50% 50%' || pos === 'center') return null;
    // Return as {x, y} 0-1 normalized for the plugin.
    const m = pos.match(/(-?[\d.]+)%\s+(-?[\d.]+)%/);
    if (m) return { x: parseFloat(m[1]) / 100, y: parseFloat(m[2]) / 100 };
    return null;
  }

  // overflow: hidden / clip → mark frame as clip-content. Children outside
  // the parent rect are clipped in Figma like in the browser.
  function clipsContent(cs) {
    return cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden'
        || cs.overflow === 'clip' || cs.overflowX === 'clip' || cs.overflowY === 'clip';
  }

  function aspectRatioOf(cs) {
    const v = cs.aspectRatio;
    if (!v || v === 'auto') return null;
    const m = v.match(/^([\d.]+)\s*\/\s*([\d.]+)/);
    if (m) return parseFloat(m[1]) / parseFloat(m[2]);
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
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

  // Build a Figma fill stack (bottom to top). Supports multi-layer
  // backgrounds: e.g. background: linear-gradient(...), url(...), #color.
  // The plugin will apply this as Figma's fills array (multiple paints).
  // Returns either a single CSS string (back-compat) OR an array of
  // gradient/solid/image descriptors. The plugin handles both shapes.
  function fillOf(cs) {
    const bgImage = cs.backgroundImage;
    const bgColor = rgbToHex(cs.backgroundColor);
    if (!bgImage || bgImage === 'none') return bgColor;
    // Tokenize the layered background-image. Each layer is gradient(...) or url(...).
    const layers = splitTopLevel(bgImage, ',');
    if (layers.length === 1) {
      // Single-layer fast path — keep the legacy string shape.
      const l = layers[0].trim();
      if (/^linear-gradient\(/i.test(l)) return l;
      // url(...) is captured via _bgUrl on the frame; fall back to color.
      if (/^url\(/i.test(l)) return bgColor;
      return bgColor;
    }
    // Multi-layer: emit a stack. Bottom (solid bg color) → top (each layer).
    const stack = [];
    if (bgColor) stack.push({ kind: 'solid', color: bgColor });
    // CSS paints layers in document order, FIRST layer is on TOP. Figma
    // renders fills array in increasing index order — last index on top.
    // So reverse: last CSS layer = first Figma fill = bottom.
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i].trim();
      if (/^linear-gradient\(/i.test(l)) stack.push({ kind: 'linear-gradient', value: l });
      else if (/^url\(/i.test(l)) {
        const m = l.match(/url\(['"]?([^'")]+)['"]?\)/);
        if (m) stack.push({ kind: 'image', url: m[1] });
      }
    }
    return stack;
  }

  function splitTopLevel(s, sep) {
    const out = []; let depth = 0; let buf = '';
    for (const ch of s) {
      if (ch === '(') depth++; else if (ch === ')') depth--;
      if (ch === sep && depth === 0) { out.push(buf); buf = ''; }
      else buf += ch;
    }
    if (buf) out.push(buf);
    return out;
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

  // Borders. Capture width + color + style (solid/dashed/dotted). Figma
  // supports SOLID/DASHED stroke styles via dashPattern (no native dotted —
  // approximate as dashed with short segments).
  function strokeOf(cs) {
    const w = px(cs.borderTopWidth) || 0;
    if (w === 0 || cs.borderTopStyle === 'none') return null;
    const c = rgbToHex(cs.borderTopColor);
    if (!c) return null;
    let dashPattern = null;
    if (cs.borderTopStyle === 'dashed') dashPattern = [w * 3, w * 2];
    else if (cs.borderTopStyle === 'dotted') dashPattern = [w, w];
    return { color: c, width: w, style: cs.borderTopStyle, dashPattern };
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
    const name = nameForNode(el, tag);

    // <img> → rect (image bytes inlined as data URL when embedImages opt is on).
    if (tag === 'img') {
      const fill = rgbToHex(cs.backgroundColor);
      // object-fit: cover → FILL, contain → FIT, fill (default) → CROP, none → CROP, scale-down → FIT
      const fitMap = { cover: 'FILL', contain: 'FIT', fill: 'CROP', none: 'CROP', 'scale-down': 'FIT' };
      const node = {
        type: 'rect',
        name: name + ':img',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        fill: fill || '#e2e8f0',
        cornerRadius: radius(cs),
        imageScaleMode: fitMap[cs.objectFit] || 'FILL',
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
      // Resolve <use href="#id"> references inline so the SVG is
      // self-contained when the plugin parses it. (Outside the parent
      // <svg> scope the symbol wouldn't be found.)
      let svgSrc = el.outerHTML;
      const symbolMap = {};
      document.querySelectorAll('symbol[id], defs > [id]').forEach(s => { symbolMap[s.id] = s.outerHTML; });
      svgSrc = svgSrc.replace(/<use\s[^>]*?(?:xlink:)?href=['"]#([^'"]+)['"][^>]*\/?>/g, (m, id) => {
        return symbolMap[id] ? symbolMap[id].replace(/^<symbol/, '<g').replace(/<\/symbol>$/, '</g>') : m;
      });
      // Ensure the SVG has explicit width/height attributes — Figma's
      // createNodeFromSvg sometimes pegs to viewBox without these.
      const r = el.getBoundingClientRect();
      if (!/<svg[^>]+\bwidth=/.test(svgSrc)) svgSrc = svgSrc.replace(/<svg/, `<svg width="${Math.round(r.width)}" height="${Math.round(r.height)}"`);
      return {
        type: 'svg',
        name: name + ':svg',
        width: Math.round(r.width),
        height: Math.round(r.height),
        _svg: svgSrc,
        _color: rgbToHex(cs.color),
      };
    }
    // <input> / <textarea> → frame styled like the input, with a text
    // child showing the current value or placeholder. Radio + checkbox
    // get rendered as their visual indicator (filled/empty circle or
    // square). Select shows the currently-selected option text.
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const inputType = (tag === 'input' ? el.getAttribute('type') : null) || tag;
      const r = el.getBoundingClientRect();
      if (inputType === 'radio' || inputType === 'checkbox') {
        const checked = el.checked || el.hasAttribute('checked');
        return {
          type: 'rect',
          name: name + ':' + inputType,
          width: Math.round(r.width),
          height: Math.round(r.height),
          fill: checked ? (rgbToHex(cs.accentColor) || '#0f172a') : (rgbToHex(cs.backgroundColor) || '#ffffff'),
          stroke: { color: rgbToHex(cs.borderTopColor) || '#94a3b8', width: 1 },
          cornerRadius: inputType === 'radio' ? Math.max(r.width, r.height) : (radius(cs) || 4),
        };
      }
      if (tag === 'select') {
        const opt = el.selectedOptions && el.selectedOptions[0];
        const text = opt ? opt.textContent.trim() : (el.options[0] ? el.options[0].textContent.trim() : '');
        return {
          type: 'frame',
          name: name + ':select',
          layout: 'HORIZONTAL',
          padding: padOf(cs),
          fill: fillOf(cs),
          cornerRadius: radius(cs),
          stroke: strokeOf(cs),
          width: Math.round(r.width),
          height: Math.round(r.height),
          children: text ? [{
            type: 'text', name: name + ':value',
            characters: text + ' ▾',
            fontSize: Math.round(px(cs.fontSize) || 14),
            fontFamily: fontFamilyOf(cs),
            color: rgbToHex(cs.color),
          }] : [],
        };
      }
      const isText = tag === 'textarea' || ['text','email','search','tel','url','password',null,'','number'].includes(inputType);
      const value = el.value || el.getAttribute('value');
      const placeholder = el.getAttribute('placeholder') || '';
      const display = value || placeholder;
      const isPlaceholder = !value && !!placeholder;
      const frame = {
        type: 'frame',
        name: name + ':' + tag,
        layout: 'HORIZONTAL',
        padding: padOf(cs),
        fill: fillOf(cs),
        cornerRadius: radius(cs),
        stroke: strokeOf(cs),
        outline: outlineOf(cs),
        opacity: opacityOf(cs),
        width: Math.round(r.width),
        height: Math.round(r.height),
        children: isText && display ? [{
          type: 'text',
          name: name + ':value',
          characters: display,
          fontSize: Math.round(px(cs.fontSize) || 14),
          fontWeight: fontWeight(cs),
          fontFamily: fontFamilyOf(cs),
          color: isPlaceholder ? '#94a3b8' : rgbToHex(cs.color),
          opacity: isPlaceholder ? 0.6 : opacityOf(cs),
        }] : [],
      };
      return frame;
    }
    // <table> → VERTICAL frame of HORIZONTAL row-frames. Better than the
    // default "huge nested frame mess" — tables render as proper grids
    // in Figma.
    if (tag === 'table') {
      const rTbl = el.getBoundingClientRect();
      const rows = [];
      for (const tr of el.querySelectorAll(':scope > tbody > tr, :scope > thead > tr, :scope > tr')) {
        const cells = [];
        const rRow = tr.getBoundingClientRect();
        for (const td of tr.querySelectorAll('th, td')) {
          const cs2 = getComputedStyle(td);
          const rCell = td.getBoundingClientRect();
          cells.push({
            type: 'frame', name: td.tagName.toLowerCase(),
            layout: 'HORIZONTAL', padding: padOf(cs2),
            fill: fillOf(cs2), stroke: strokeOf(cs2),
            width: Math.round(rCell.width), height: Math.round(rCell.height),
            children: [{
              type: 'text', characters: td.textContent.trim().slice(0, 200),
              fontSize: Math.round(px(cs2.fontSize) || 14),
              fontWeight: fontWeight(cs2), fontFamily: fontFamilyOf(cs2),
              color: rgbToHex(cs2.color),
            }],
          });
        }
        rows.push({
          type: 'frame', name: 'tr', layout: 'HORIZONTAL',
          width: Math.round(rRow.width), height: Math.round(rRow.height),
          children: cells,
        });
      }
      return {
        type: 'frame', name: 'table', layout: 'VERTICAL',
        fill: fillOf(cs), stroke: strokeOf(cs), cornerRadius: radius(cs),
        width: Math.round(rTbl.width), height: Math.round(rTbl.height),
        children: rows,
      };
    }
    // <details> / <summary>: render in current open/closed state.
    if (tag === 'details') {
      const rDet = el.getBoundingClientRect();
      const isOpen = el.open || el.hasAttribute('open');
      const frame = {
        type: 'frame', name: 'details' + (isOpen ? ':open' : ':closed'),
        layout: 'VERTICAL', padding: padOf(cs), spacing: px(cs.gap) || 0,
        fill: fillOf(cs), stroke: strokeOf(cs), cornerRadius: radius(cs),
        width: Math.round(rDet.width), height: Math.round(rDet.height),
        children: [],
      };
      for (const c of el.children) {
        if (c.tagName === 'SUMMARY' || isOpen) {
          const cn = nodeForElement(c, opts, depth + 1);
          if (cn) frame.children.push(cn);
        }
      }
      return frame;
    }
    // <video> → rect with poster image if present, else a placeholder.
    if (tag === 'video') {
      const poster = el.getAttribute('poster');
      const r = el.getBoundingClientRect();
      const node = {
        type: 'rect',
        name: name + ':video',
        width: Math.round(r.width),
        height: Math.round(r.height),
        fill: rgbToHex(cs.backgroundColor) || '#0a0a0a',
        cornerRadius: radius(cs),
      };
      if (poster) {
        try { node._bgUrl = (new URL(poster, document.baseURI)).href; } catch (e) {}
      }
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
        lineClamp: lineClampOf(cs),
        textTruncation: textTruncationOf(cs),
        color: rgbToHex(cs.color),
        opacity: opacityOf(cs),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        ranges: ranges.length ? ranges : undefined,
      };
    }

    // Button/link with text content → frame containing a single text child.
    if ((tag === 'button' || tag === 'a') && (hasOnlyTextChildren(el) || isInlineText(el))) {
      // Hyperlink — Figma supports node.hyperlink {type, value} on text
      // nodes so designers can click through in prototypes.
      const href = tag === 'a' ? el.getAttribute('href') : null;
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
        hyperlink: href ? { url: href.startsWith('#') || href.startsWith('/') ? new URL(href, document.baseURI).href : href } : undefined,
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
          hyperlink: href ? { url: href.startsWith('#') || href.startsWith('/') ? new URL(href, document.baseURI).href : href } : undefined,
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
      primaryAxisAlign: primaryAxisAlignOf(cs),
      counterAxisAlign: counterAxisAlignOf(cs),
      layoutGrow: layoutGrowOf(cs),
      padding: padOf(cs),
      spacing: px(cs.columnGap) || px(cs.gap) || 0,
      counterAxisSpacing: px(cs.rowGap) || px(cs.gap) || 0,
      fill: fillOf(cs),
      cornerRadius: radius(cs),
      stroke: strokeOf(cs),
      outline: outlineOf(cs),
      shadow: shadowOf(cs),
      opacity: opacityOf(cs),
      transform: transformOf(cs),
      backdropBlur: backdropBlurOf(cs),
      filterEffects: filterEffectsOf(cs),
      blendMode: blendModeOf(cs),
      aspectRatio: aspectRatioOf(cs),
      bgScaleMode: bgScaleOf(cs),
      bgPosition: bgPosOf(cs),
      clipsContent: clipsContent(cs),
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
      // Compute a structural signature for componentization: tag +
      // first-non-utility-class + visible-text-template. Siblings with
      // matching signatures are candidates for a Figma Component +
      // Instances pair.
      const sig = childSignature(child);
      draft.push({ node: cn, z: isFinite(zi) ? zi : 0, idx: draft.length, sig });
    }
    // Stable sort.
    if (!isAutoLayout && draft.length > 1) {
      draft.sort((a, b) => (a.z - b.z) || (a.idx - b.idx));
    }
    // Componentization: bucket children by signature. Groups with >= 2
    // members get a shared _componentGroupId; the plugin converts the
    // first member to a component and the others to instances.
    const groups = {};
    for (const d of draft) if (d.sig) { (groups[d.sig] = groups[d.sig] || []).push(d); }
    let nextGroupId = 0;
    for (const sig of Object.keys(groups)) {
      if (groups[sig].length < 2) continue;
      const gid = (frame.name || 'group') + '/g' + (nextGroupId++);
      for (const d of groups[sig]) d.node._componentGroupId = gid;
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
      if (opts.viewport) spec.width = opts.viewport;
      const cssVars = collectCssVariables();
      if (Object.keys(cssVars).length) spec._cssVariables = cssVars;
      // Color histogram across the whole spec — top-N go into Figma Color
      // Styles for design-system handoff.
      spec._colorHistogram = collectColorHistogram(spec);
    }
    return spec;
  };

  // Walk the finished spec, count every color used as fill/stroke/text,
  // return [{ hex, count }] sorted by count desc.
  function collectColorHistogram(root) {
    const counts = {};
    function bump(c) { if (!c) return; const h = String(c).toLowerCase(); counts[h] = (counts[h] || 0) + 1; }
    function visit(n) {
      if (!n) return;
      if (typeof n.fill === 'string') bump(n.fill);
      if (Array.isArray(n.fill)) for (const l of n.fill) if (l && l.kind === 'solid') bump(l.color);
      if (n.color) bump(n.color);
      if (n.stroke && n.stroke.color) bump(n.stroke.color);
      if (n.outline && n.outline.color) bump(n.outline.color);
      if (n.children) for (const c of n.children) visit(c);
    }
    visit(root);
    return Object.entries(counts)
      .map(([hex, count]) => ({ hex, count }))
      .filter(c => c.count >= 3 && /^#[0-9a-f]{6}$/i.test(c.hex))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  }
})();
