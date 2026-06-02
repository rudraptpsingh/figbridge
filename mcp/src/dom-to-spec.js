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
  // Build reverse map: hex color → CSS variable name. Lets us bind
  // SOLID fills to a Figma Variable instead of hardcoding the value —
  // designers can edit one token and propagate. Built lazily on first
  // call so we only pay for it once per import.
  let _cssVarByHex = null;
  function buildCssVarMap() {
    if (_cssVarByHex) return _cssVarByHex;
    _cssVarByHex = {};
    const rootStyle = window.getComputedStyle(document.documentElement);
    for (let i = 0; i < rootStyle.length; i++) {
      const prop = rootStyle.item(i);
      if (!prop.startsWith('--')) continue;
      const raw = rootStyle.getPropertyValue(prop).trim();
      // Resolve colors via a probe element so hsl/oklch normalize.
      let resolved = null;
      try {
        const probe = document.createElement('span');
        probe.style.display = 'none';
        probe.style.color = raw;
        document.body.appendChild(probe);
        resolved = getComputedStyle(probe).color;
        document.body.removeChild(probe);
      } catch (e) {}
      const hex = (resolved && _rgbToHexRaw(resolved)) || _rgbToHexRaw(raw);
      if (hex) _cssVarByHex[hex.toLowerCase()] = prop;
    }
    return _cssVarByHex;
  }
  function _rgbToHexRaw(rgb) {
    if (!rgb) return null;
    const m = rgb.match(/rgba?\(\s*([\d.]+)\s*,?\s*([\d.]+)\s*,?\s*([\d.]+)/);
    if (!m) return null;
    const hx = (n) => Math.round(parseFloat(n)).toString(16).padStart(2, '0');
    return '#' + hx(m[1]) + hx(m[2]) + hx(m[3]);
  }
  // Returns the CSS variable that maps to `hex`, or null.
  function tokenForHex(hex) {
    if (!hex) return null;
    return buildCssVarMap()[hex.toLowerCase()] || null;
  }

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

  function alphaOfColor(rgb) {
    if (!rgb || rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') return 0;
    const m = String(rgb).match(/rgba?\(\s*[\d.]+\s*,?\s*[\d.]+\s*,?\s*[\d.]+\s*(?:[,/]\s*([\d.]+%?))?/);
    if (!m || m[1] == null) return 1;
    const a = m[1].endsWith('%') ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
    if (!isFinite(a)) return 1;
    return Math.max(0, Math.min(1, a));
  }

  const SVG_STYLE_DEFAULTS = {
    'alignment-baseline': 'baseline',
    'clip': 'auto',
    'clip-path': 'none',
    'clip-rule': 'nonzero',
    'color': 'rgb(0, 0, 0)',
    'color-interpolation': 'srgb',
    'color-rendering': 'auto',
    'direction': 'ltr',
    'display': 'inline',
    'dominant-baseline': 'auto',
    'fill': 'rgb(0, 0, 0)',
    'fill-opacity': '1',
    'fill-rule': 'nonzero',
    'filter': 'none',
    'flood-color': 'rgb(0, 0, 0)',
    'flood-opacity': '1',
    'image-rendering': 'auto',
    'letter-spacing': 'normal',
    'lighting-color': 'rgb(255, 255, 255)',
    'marker-end': 'none',
    'marker-mid': 'none',
    'marker-start': 'none',
    'mask': 'none',
    'opacity': '1',
    'overflow': 'hidden',
    'paint-order': 'normal',
    'shape-rendering': 'auto',
    'stop-color': 'rgb(0, 0, 0)',
    'stop-opacity': '1',
    'stroke': 'none',
    'stroke-dasharray': 'none',
    'stroke-dashoffset': '0px',
    'stroke-linecap': 'butt',
    'stroke-linejoin': 'miter',
    'stroke-miterlimit': '4',
    'stroke-opacity': '1',
    'stroke-width': '1px',
    'text-anchor': 'start',
    'text-rendering': 'auto',
    'vector-effect': 'none',
    'visibility': 'visible',
    'white-space': 'normal',
    'writing-mode': 'horizontal-tb',
  };

  function bakeSvgStyles(svgElement) {
    const clone = svgElement.cloneNode(true);
    function copy(source, target) {
      if (!(source instanceof Element) || !(target instanceof Element)) return;
      const computed = window.getComputedStyle(source);
      target.removeAttribute('class');
      target.removeAttribute('style');
      Object.keys(SVG_STYLE_DEFAULTS).forEach(prop => {
        const value = computed.getPropertyValue(prop);
        const def = SVG_STYLE_DEFAULTS[prop];
        if (value && value.toLowerCase() !== def) target.setAttribute(prop, value);
      });
      for (let i = 0; i < source.childNodes.length; i++) copy(source.childNodes[i], target.childNodes[i]);
    }
    copy(svgElement, clone);
    const rect = svgElement.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      clone.setAttribute('width', String(Math.round(rect.width)));
      clone.setAttribute('height', String(Math.round(rect.height)));
    }
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return clone.outerHTML;
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
    // Tailwind utility classes. Prefixes need a trailing - or digit so
    // we don't accidentally match "mf-seg" (m → margin) or "ben" (b → ?).
    // Also catches arbitrary-value brackets and fraction slashes.
    return /^(p|m|mt|mb|ml|mr|mx|my|w|h|min|max|text|bg|gap|space|rounded|shadow|opacity|inset|top|left|right|bottom|order|col|row|grid|flex|items|justify|self|content|place|gap)-/.test(cls)
      || /^(p|m|mt|mb|ml|mr|mx|my|w|h)\d/.test(cls)
      || /^(flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|sr-only)$/.test(cls)
      || /^(md|lg|sm|xl|hover|focus|active|disabled|first|last|dark):/.test(cls)
      || /\[/.test(cls)
      || /\//.test(cls);
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
    // Figbridge does not yet write component-property overrides for text.
    // If two cards share structure but not copy, componentizing them would
    // turn every instance into the first card's content. Include visible
    // text in the signature until variant/text overrides exist.
    const textFingerprint = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return tag + '|' + cls + '|' + tagFingerprint + '|' + textFingerprint;
  }

  // Join ALL semantic (non-utility) classes on an element so structural
  // diffs against source HTML see every class name in the node name.
  // E.g. <a class="cta-big primary"> → ".cta-big.primary"
  function allSemanticClasses(className) {
    if (typeof className !== 'string' || !className) return '';
    return className.split(/\s+/).filter(c => c && !looksUtility(c)).join('.');
  }

  function nameForNode(el, tag) {
    if (el.id) return '#' + el.id;
    if (['h1','h2','h3','h4','h5','h6','p','blockquote','figcaption','button'].includes(tag)) {
      const tc = (el.textContent || '').trim().slice(0, 40);
      if (tc) return (SEMANTIC_NAMES[tag] || tag) + ': ' + tc + (tc.length === 40 ? '…' : '');
    }
    const allCls = allSemanticClasses(el.className);
    if (allCls) return '.' + allCls.slice(0, 48);
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

  function pageBackgroundFill() {
    const bodyColor = document.body ? rgbToHex(window.getComputedStyle(document.body).backgroundColor) : null;
    if (bodyColor) return bodyColor;
    const htmlColor = document.documentElement ? rgbToHex(window.getComputedStyle(document.documentElement).backgroundColor) : null;
    return htmlColor || null;
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
    return visibleTextValue(el).length > 0;
  }

  // Headings / paragraphs / buttons frequently contain inline spans
  // (highlight rules, masks, em). The leading direct-text-node would
  // otherwise be dropped. Returns true if the element is a known
  // "text-y" tag and ALL nested content is text-like (no images, no
  // block children, no svg).
  const INLINE_TEXT_TAGS = new Set(['h1','h2','h3','h4','h5','h6','p','a','button','label','strong','em','span','blockquote']);
  const BLOCK_TAGS = new Set(['section','header','footer','article','aside','main','div']);
  const MEDIA_TAGS = new Set(['img','video','canvas','iframe','picture','hr']);
  const SKIP_TAGS = new Set(['script','style','noscript','template','meta','link']);

  function isSkippedTextContainer(node) {
    let p = node && node.parentElement;
    while (p) {
      if (SKIP_TAGS.has(p.tagName.toLowerCase())) return true;
      p = p.parentElement;
    }
    return false;
  }

  function visibleTextValue(el) {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isSkippedTextContainer(node)) return NodeFilter.FILTER_REJECT;
        return node.textContent && node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let n;
    while ((n = walker.nextNode())) parts.push(n.textContent);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function isInlineText(el) {
    const tag = el.tagName.toLowerCase();
    if (!INLINE_TEXT_TAGS.has(tag)) return false;
    // Block-level / media kill the textification.
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
    // Additional rule for buttons/links: don't collapse to a single
    // text node when the inner content carries visible styling that
    // would be lost (background, border, shadow, transform).
    if (tag === 'a' || tag === 'button') {
      let semanticSpanKids = 0;
      for (const c of el.children) {
        if (c.tagName === 'SPAN' && firstSemanticClass(c.className)) semanticSpanKids++;
        // Inner element with a non-transparent background → it's a
        // visual element (badge, logo box, pill), not inline text.
        const ccs = window.getComputedStyle(c);
        if (rgbToHex(ccs.backgroundColor)) return false;
        if (ccs.boxShadow && ccs.boxShadow !== 'none') return false;
        if (parseFloat(ccs.borderTopWidth) > 0 && ccs.borderTopStyle !== 'none') return false;
      }
      if (semanticSpanKids >= 2) return false;
    }
    return visibleTextValue(el).length > 0;
  }

  function getTextValue(el) {
    return visibleTextValue(el);
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

  // overflow: hidden / clip. CSS allows single-axis hidden (common for
  // horizontal-scroll prevention) but Figma's clipsContent is binary —
  // clips on both axes. Only set when BOTH axes are hidden, OR when the
  // shorthand `overflow` is hidden/clip (which implies both axes).
  function clipsContent(cs) {
    if (cs.overflow === 'hidden' || cs.overflow === 'clip') return true;
    const xHidden = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
    const yHidden = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
    return xHidden && yHidden;
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

  // Build a Figma fill stack. When the resolved bg color matches a known
  // --var, emit { kind: 'solid', color, token } so the plugin can bind
  // the paint to that Figma Variable. Designers edit one var, every
  // bound paint updates.
  function fillOf(cs) {
    const bgImage = cs.backgroundImage;
    const bgColor = rgbToHex(cs.backgroundColor);
    const bgAlpha = alphaOfColor(cs.backgroundColor);
    if (!bgImage || bgImage === 'none') {
      if (!bgColor) return null;
      const tok = bgAlpha >= 0.999 ? tokenForHex(bgColor) : null;
      // Emit token-aware shape when a match found; else legacy string.
      if (tok) return [{ kind: 'solid', color: bgColor, token: tok }];
      if (bgAlpha < 0.999) return [{ kind: 'solid', color: bgColor, alpha: bgAlpha }];
      return bgColor;
    }
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
    if (bgColor) stack.push(bgAlpha < 0.999 ? { kind: 'solid', color: bgColor, alpha: bgAlpha } : { kind: 'solid', color: bgColor });
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
    const alpha = alphaOfColor(cs.borderTopColor);
    let dashPattern = null;
    if (cs.borderTopStyle === 'dashed') dashPattern = [w * 3, w * 2];
    else if (cs.borderTopStyle === 'dotted') dashPattern = [w, w];
    return { color: c, alpha, width: w, style: cs.borderTopStyle, dashPattern };
  }

  // Parse a single CSS box-shadow into { x, y, blur, spread, color, alpha,
  // inset }. CRITICAL: preserve alpha separately from the hex color
  // because rgbToHex strips it. Without alpha, every shadow renders at
  // full opacity (e.g. rgba(0,0,0,0.35) → solid black halo, 3x too dark).
  function shadowOf(cs) {
    const raw = cs.boxShadow;
    if (!raw || raw === 'none') return null;
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
      // Extract alpha from rgba(R,G,B,A) or rgb(R G B / A). Default 1.
      let alpha = 1;
      const am = colorRaw.match(/rgba?\([^)]*?[,/]\s*([\d.]+%?)\s*\)/i);
      if (am) alpha = am[1].endsWith('%') ? parseFloat(am[1]) / 100 : parseFloat(am[1]);
      const after = p.replace(colorRaw, '').replace(/\binset\b/, '').trim();
      const nums = (after.match(/-?[\d.]+px/g) || []).map(s => parseFloat(s));
      if (nums.length < 2) continue;
      out.push({
        x: nums[0] || 0,
        y: nums[1] || 0,
        blur: nums[2] || 0,
        spread: nums[3] || 0,
        color,
        alpha,
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
    if (w >= 900) return 'Black';
    if (w >= 800) return 'Extra Bold';
    if (w >= 700) return 'Bold';
    if (w >= 600) return 'Semi Bold';
    if (w >= 500) return 'Medium';
    if (w >= 350) return 'Regular';
    if (w >= 250) return 'Light';
    return 'Thin';
  }

  function nodeBoundsForParent(child, cn) {
    if (cn && cn._absBounds) return cn._absBounds;
    const r = child.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  function nodeForDisplayContents(el, opts, depth) {
    const tag = el.tagName.toLowerCase();
    const name = nameForNode(el, tag);
    const frame = {
      type: 'frame',
      name: name + ':contents',
      layout: 'NONE',
      fill: null,
      width: 0,
      height: 0,
      children: [],
    };
    const draft = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt || isSkippedTextContainer(node)) continue;
        draft.push({
          node: {
            type: 'text',
            name: 'text:' + txt.slice(0, 24),
            characters: txt,
          },
          bounds: null,
        });
        continue;
      }
      if (node.nodeType !== 1) continue;
      const child = node;
      const cn = nodeForElement(child, opts, depth + 1);
      if (!cn) continue;
      const b = nodeBoundsForParent(child, cn);
      if (b.width > 0 && b.height > 0) {
        minX = Math.min(minX, b.left);
        minY = Math.min(minY, b.top);
        maxX = Math.max(maxX, b.left + b.width);
        maxY = Math.max(maxY, b.top + b.height);
      }
      draft.push({ node: cn, bounds: b });
    }

    if (!draft.length) return null;
    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
      minX = 0; minY = 0; maxX = 0; maxY = 0;
    }
    frame.width = Math.round(Math.max(1, maxX - minX));
    frame.height = Math.round(Math.max(1, maxY - minY));
    frame._absBounds = { left: minX, top: minY, width: frame.width, height: frame.height };
    for (const d of draft) {
      if (d.bounds) {
        d.node.x = Math.round(d.bounds.left - minX);
        d.node.y = Math.round(d.bounds.top - minY);
      }
      frame.children.push(d.node);
    }
    return frame;
  }

  function nodeForElement(el, opts, depth) {
    const cs = window.getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return null;
    if (cs.display === 'contents') return nodeForDisplayContents(el, opts, depth);
    if (!isVisible(el, cs)) return null;
    const rect = el.getBoundingClientRect();
    const name = nameForNode(el, tag);

    // <img> → rect (image bytes inlined as data URL when embedImages opt is on).
    if (tag === 'img') {
      const fill = rgbToHex(cs.backgroundColor);
      const fitMap = { cover: 'FILL', contain: 'FIT', fill: 'CROP', none: 'CROP', 'scale-down': 'FIT' };
      // Resolve src against the element's ownerDocument (matters for
      // unfolded iframes whose baseURI is the iframe page, not the parent).
      const ownerDoc = el.ownerDocument || document;
      const rawSrc = el.getAttribute('src');
      let absSrc = null;
      if (rawSrc) {
        try { absSrc = new URL(rawSrc, ownerDoc.baseURI).href; }
        catch (e) { absSrc = rawSrc; }
      }
      const node = {
        type: 'rect',
        name: name + ':img',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        fill: fill || '#e2e8f0',
        cornerRadius: radius(cs),
        imageScaleMode: fitMap[cs.objectFit] || 'FILL',
        _src: absSrc,
        // Mark as bg-url so the server-side fetcher picks it up — same
        // path as background-image: url(). One pipeline for both.
        _bgUrl: absSrc,
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
    // <iframe>: if same-origin we UNFOLD the iframe's DOM into native
    // Figma frames here. Way more useful than a flat screenshot: the
    // demo deck becomes real editable layers (text, fills, borders) in
    // Figma. Falls back to screenshot substitution when cross-origin.
    if (tag === 'iframe') {
      let innerBody = null;
      try { innerBody = el.contentDocument && el.contentDocument.body; } catch (e) {}
      if (innerBody && innerBody.children.length) {
        // Recurse into the iframe's body. We carry the iframe's outer
        // position so its children align in the parent page coordinates.
        const innerSpec = nodeForElement(innerBody, opts, depth + 1);
        if (innerSpec) {
          innerSpec.name = name + ':iframe(' + (el.getAttribute('src') || '?') + ')';
          innerSpec.width = Math.round(rect.width);
          innerSpec.height = Math.round(rect.height);
          // Override the body fill with the iframe's CSS bg if set.
          if (rgbToHex(cs.backgroundColor)) innerSpec.fill = rgbToHex(cs.backgroundColor);
          return innerSpec;
        }
      }
      // Fallback: cross-origin, mark for puppeteer screenshot.
      const allFrames = Array.from(document.querySelectorAll('iframe'));
      return {
        type: 'rect',
        name: name + ':iframe',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        fill: rgbToHex(cs.backgroundColor) || '#e2e8f0',
        cornerRadius: radius(cs),
        _iframeIdx: allFrames.indexOf(el),
        _src: el.getAttribute('src') || null,
      };
    }
    // <svg> → carry the outerHTML so the plugin can do
    // figma.createNodeFromSvg() and produce real vector layers.
    if (tag === 'svg') {
      // Resolve <use href="#id"> references inline so the SVG is
      // self-contained when the plugin parses it. (Outside the parent
      // <svg> scope the symbol wouldn't be found.)
      let svgSrc = bakeSvgStyles(el);
      const symbolMap = {};
      document.querySelectorAll('symbol[id], defs > [id]').forEach(s => { symbolMap[s.id] = s.outerHTML; });
      svgSrc = svgSrc.replace(/<use\s[^>]*?(?:xlink:)?href=['"]#([^'"]+)['"][^>]*>(?:\s*<\/use>)?|<use\s[^>]*?(?:xlink:)?href=['"]#([^'"]+)['"][^>]*\/>/g, (m, id1, id2) => {
        const id = id1 || id2;
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
      if (opts.embedImages) {
        try {
          if (el.videoWidth && el.videoHeight && el.readyState >= 2) {
            const c = document.createElement('canvas');
            c.width = Math.max(1, el.videoWidth);
            c.height = Math.max(1, el.videoHeight);
            const ctx = c.getContext('2d');
            ctx.drawImage(el, 0, 0, c.width, c.height);
            node._imageBytes = c.toDataURL('image/png');
          }
        } catch (e) {}
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
    // Refuse to emit as text-leaf if the element itself has a visible
    // background, shadow, or border — those are visual boxes the author
    // wants rendered, not invisible text containers. Fall through to the
    // frame branch so the styling survives.
    const hasOwnBoxStyling = !!(rgbToHex(cs.backgroundColor) || (cs.boxShadow && cs.boxShadow !== 'none') || (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none'));
    if (!hasOwnBoxStyling && (hasOnlyTextChildren(el) || isInlineText(el)) && !['button', 'a'].includes(tag)) {
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
    // + inline them. Resolve against the element's ownerDocument so
    // unfolded iframes use their own baseURI (not the parent page's).
    const bgImage = cs.backgroundImage;
    if (bgImage && bgImage !== 'none') {
      frame._bgImage = bgImage;
      const urlMatch = bgImage.match(/url\(['"]?([^'")]+)['"]?\)/);
      if (urlMatch) {
        const ownerDoc = el.ownerDocument || document;
        try { frame._bgUrl = new URL(urlMatch[1], ownerDoc.baseURI).href; }
        catch (e) { frame._bgUrl = urlMatch[1]; }
      }
    }

    if (depth >= opts.maxDepth) return frame;

    // Capture parent rect once so we can emit per-child relative offsets
    // when the parent is *not* an auto-layout container. Without these,
    // children would all land at (0,0) inside a NONE-layout frame and
    // visually pile up on top of each other.
    const parentRect = rect;
    const isAutoLayout = frame.layout === 'VERTICAL' || frame.layout === 'HORIZONTAL';
    let hasAbsoluteChild = false;

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
      if (ps.position === 'absolute' || ps.position === 'fixed') hasAbsoluteChild = true;
      if (!isAutoLayout || ps.position === 'absolute' || ps.position === 'fixed') {
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

    // Track the visual extent of children — even for auto-layout parents,
    // because absolutely-positioned children can overflow the declared
    // parent box in HTML, and Figma's auto-layout clips them.
    let childMaxY = 0;
    let childMaxX = 0;
    const draft = [];
    // Walk childNodes (not children) so we also pick up TEXT nodes
    // interleaved between element children. Example:
    //   <a class="cta"><svg/>Download for macOS<span class="arrow"/></a>
    // The "Download for macOS" between the svg and span is a text node;
    // el.children skips it, dropping the visible text. We emit each
    // non-empty text node as a synthetic text child, styled from the
    // parent's computed CSS.
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt) continue;
        // Mixed-content text node — emit as a text child inheriting
        // parent typography. Positioning relies on auto-layout primary
        // axis (HORIZONTAL flows next to the icon naturally) or per-x/y
        // if no layout.
        draft.push({
          node: {
            type: 'text',
            name: 'text:' + txt.slice(0, 24),
            characters: txt,
            fontSize: Math.round(px(cs.fontSize) || 16),
            fontWeight: fontWeight(cs),
            fontFamily: fontFamilyOf(cs),
            color: rgbToHex(cs.color),
          },
          z: 0, idx: draft.length, sig: null,
        });
        continue;
      }
      if (node.nodeType !== 1) continue;
      const child = node;
      const cn = nodeForElement(child, opts, depth + 1);
      if (!cn) continue;
      const cr = nodeBoundsForParent(child, cn);
      const childCs0 = window.getComputedStyle(child);
      if (childCs0.position === 'absolute' || childCs0.position === 'fixed') hasAbsoluteChild = true;
      const relRight  = (cr.left - parentRect.left) + cr.width;
      const relBottom = (cr.top  - parentRect.top)  + cr.height;
      if (relRight  > childMaxX) childMaxX = relRight;
      if (relBottom > childMaxY) childMaxY = relBottom;
      if (!isAutoLayout) {
        cn.x = Math.round(cr.left - parentRect.left);
        cn.y = Math.round(cr.top  - parentRect.top);
      }
      const childCs = window.getComputedStyle(child);
      const zi = parseInt(childCs.zIndex, 10);
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

    // If any child uses position:absolute|fixed, the parent's auto-layout
    // would clip those children's visual position. Drop auto-layout and
    // emit per-child x/y, matching the live render.
    if (hasAbsoluteChild && (frame.layout === 'VERTICAL' || frame.layout === 'HORIZONTAL')) {
      frame.layout = 'NONE';
      // Need to add x/y for children that don't have them yet.
      let idx = 0;
      for (const child of el.children) {
        const cn = draft[idx] && draft[idx].node;
        if (cn) {
          const cr2 = child.getBoundingClientRect();
          cn.x = Math.round(cr2.left - parentRect.left);
          cn.y = Math.round(cr2.top  - parentRect.top);
        }
        idx++;
      }
    }
    // Trust children's visual extent over CSS-declared height/width. This
    // catches both NONE-layout and (now) demoted auto-layout frames whose
    // CSS height understates the real content extent.
    if (childMaxY > frame.height) frame.height = Math.ceil(childMaxY);
    if (childMaxX > frame.width)  frame.width  = Math.ceil(childMaxX);

    // If a flex container has zero element children but has a text leaf,
    // emit a text node too (some sites stuff text directly into a flex row).
    if (frame.children.length === 0 && visibleTextValue(el)) {
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
      if (rootSelector !== 'body' && rootSelector !== 'html' && !spec.fill) {
        const inheritedFill = pageBackgroundFill();
        if (inheritedFill) spec.fill = inheritedFill;
      }
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
