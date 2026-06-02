(function () {
  if (window.__figbridgeCaptureInstalled) return;
  window.__figbridgeCaptureInstalled = true;

  var selectedElement = null;
  var hoverBox = null;
  var captureViewportOnly = false;

  function px(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  function color(v) {
    if (!v || v === "transparent" || v === "rgba(0, 0, 0, 0)") return null;
    return v;
  }

  function firstFont(cs) {
    return (cs.fontFamily || "Inter").split(",")[0].replace(/['"]/g, "").trim() || "Inter";
  }

  function nameFor(el, tag) {
    if (el.id) return "#" + el.id;
    var cls = typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean)[0] : "";
    if (cls) return "." + cls.slice(0, 48);
    if (tag === "body") return "Chrome current tab";
    if (tag === "img") return "Image";
    if (tag === "svg") return "SVG";
    if (/^h[1-6]$/.test(tag)) return "Heading";
    if (tag === "p") return "Paragraph";
    if (tag === "a") return "Link";
    if (tag === "button") return "Button";
    return tag;
  }

  function isSkipped(el) {
    var tag = el.tagName && el.tagName.toLowerCase();
    return tag === "script" || tag === "style" || tag === "noscript" || tag === "template" || tag === "meta" || tag === "link";
  }

  function isVisible(el, cs) {
    if (isSkipped(el)) return false;
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (cs.display === "contents") return true;
    var r = el.getBoundingClientRect();
    if (captureViewportOnly && r.bottom < 0) return false;
    if (captureViewportOnly && r.top > window.innerHeight) return false;
    if (captureViewportOnly && r.right < 0) return false;
    if (captureViewportOnly && r.left > window.innerWidth) return false;
    return r.width >= 1 && r.height >= 1;
  }

  function visibleText(el) {
    var out = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var p = node.parentElement;
        while (p) {
          if (isSkipped(p)) return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return node.textContent && node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var n;
    while ((n = walker.nextNode())) out.push(n.textContent);
    return out.join(" ").replace(/\s+/g, " ").trim();
  }

  function hasElementChildren(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 1 && !isSkipped(el.childNodes[i])) return true;
    }
    return false;
  }

  function fillOf(cs) {
    var bg = cs.backgroundColor;
    if (color(bg)) return bg;
    return null;
  }

  function strokeOf(cs) {
    var w = px(cs.borderTopWidth);
    if (!w || cs.borderTopStyle === "none") return null;
    return { color: color(cs.borderTopColor) || "#000000", width: w };
  }

  function layoutOf(cs) {
    if (cs.display && cs.display.indexOf("flex") >= 0) {
      return cs.flexDirection && cs.flexDirection.indexOf("row") === 0 ? "HORIZONTAL" : "VERTICAL";
    }
    if (cs.display && cs.display.indexOf("grid") >= 0) return "HORIZONTAL";
    return "NONE";
  }

  function rectToBounds(r) {
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  function addCommon(node, el, cs, r) {
    node.width = Math.max(1, Math.round(r.width));
    node.height = Math.max(1, Math.round(r.height));
    var radius = px(cs.borderTopLeftRadius);
    if (radius) node.cornerRadius = radius;
    var stroke = strokeOf(cs);
    if (stroke) node.stroke = stroke;
    if (cs.boxShadow && cs.boxShadow !== "none") node.shadow = true;
    var opacity = parseFloat(cs.opacity);
    if (isFinite(opacity) && opacity < 1) node.opacity = opacity;
    return node;
  }

  function imageSrc(el) {
    var raw = el.currentSrc || el.src || el.getAttribute("src") || el.getAttribute("data-src") || "";
    if (!raw) return null;
    try { return new URL(raw, document.baseURI).href; }
    catch (e) { return raw; }
  }

  function nodeForDisplayContents(el, depth, maxDepth) {
    var children = [];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      var cn = nodeFor(child, depth + 1, maxDepth);
      if (!cn) continue;
      var b = cn._absBounds || rectToBounds(child.getBoundingClientRect());
      minX = Math.min(minX, b.left);
      minY = Math.min(minY, b.top);
      maxX = Math.max(maxX, b.left + b.width);
      maxY = Math.max(maxY, b.top + b.height);
      children.push({ node: cn, bounds: b });
    }
    if (!children.length) return null;
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
    var frame = {
      type: "frame",
      name: nameFor(el, el.tagName.toLowerCase()) + ":contents",
      layout: "NONE",
      width: Math.max(1, Math.round(maxX - minX)),
      height: Math.max(1, Math.round(maxY - minY)),
      children: []
    };
    frame._absBounds = { left: minX, top: minY, width: frame.width, height: frame.height };
    children.forEach(function (entry) {
      entry.node.x = Math.round(entry.bounds.left - minX);
      entry.node.y = Math.round(entry.bounds.top - minY);
      delete entry.node._absBounds;
      frame.children.push(entry.node);
    });
    return frame;
  }

  function nodeFor(el, depth, maxDepth) {
    if (!el || !el.tagName) return null;
    var cs = getComputedStyle(el);
    var tag = el.tagName.toLowerCase();
    if (!isVisible(el, cs)) return null;
    if (cs.display === "contents") return nodeForDisplayContents(el, depth, maxDepth);
    var r = el.getBoundingClientRect();
    var name = nameFor(el, tag);

    if (tag === "img") {
      var img = addCommon({ type: "rect", name: name + ":img", fill: "#e2e8f0", imageScaleMode: cs.objectFit === "contain" ? "FIT" : "FILL" }, el, cs, r);
      var src = imageSrc(el);
      if (src) img._bgUrl = src;
      return img;
    }

    if (tag === "video") {
      var video = addCommon({ type: "rect", name: name + ":video", fill: "#0a0a0a", imageScaleMode: "FILL" }, el, cs, r);
      var poster = el.getAttribute("poster");
      if (poster) {
        try { video._bgUrl = new URL(poster, document.baseURI).href; } catch (e) { video._bgUrl = poster; }
      }
      try {
        if (el.videoWidth && el.videoHeight && el.readyState >= 2) {
          var c = document.createElement("canvas");
          c.width = el.videoWidth;
          c.height = el.videoHeight;
          c.getContext("2d").drawImage(el, 0, 0, c.width, c.height);
          video._imageBytes = c.toDataURL("image/png");
        }
      } catch (e) {}
      return video;
    }

    if (tag === "svg") {
      return addCommon({ type: "svg", name: name + ":svg", _svg: el.outerHTML, _color: color(cs.color) }, el, cs, r);
    }

    var text = visibleText(el);
    if (text && !hasElementChildren(el) && tag !== "body" && tag !== "html") {
      return addCommon({
        type: "text",
        name: name,
        characters: text,
        fontSize: Math.round(px(cs.fontSize) || 16),
        fontWeight: cs.fontWeight || "400",
        fontFamily: firstFont(cs),
        lineHeight: Math.round(px(cs.lineHeight) || 0) || undefined,
        textAlign: cs.textAlign ? cs.textAlign.toUpperCase() : undefined,
        color: color(cs.color) || "#111111"
      }, el, cs, r);
    }

    var frame = addCommon({
      type: "frame",
      name: name,
      layout: layoutOf(cs),
      padding: {
        top: px(cs.paddingTop),
        right: px(cs.paddingRight),
        bottom: px(cs.paddingBottom),
        left: px(cs.paddingLeft)
      },
      spacing: px(cs.columnGap || cs.gap),
      fill: fillOf(cs),
      children: []
    }, el, cs, r);

    var bg = cs.backgroundImage;
    if (bg && bg !== "none") {
      var m = bg.match(/url\(['"]?([^'")]+)['"]?\)/);
      if (m) {
        try { frame._bgUrl = new URL(m[1], document.baseURI).href; }
        catch (e) { frame._bgUrl = m[1]; }
      }
    }

    if (depth >= maxDepth) return frame;

    var isAuto = frame.layout === "VERTICAL" || frame.layout === "HORIZONTAL";
    var parent = r;
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      var cn = nodeFor(child, depth + 1, maxDepth);
      if (!cn) continue;
      var cr = cn._absBounds || rectToBounds(child.getBoundingClientRect());
      if (!isAuto || getComputedStyle(child).position === "absolute" || getComputedStyle(child).position === "fixed") {
        frame.layout = "NONE";
        cn.x = Math.round(cr.left - parent.left);
        cn.y = Math.round(cr.top - parent.top);
      }
      delete cn._absBounds;
      frame.children.push(cn);
    }

    if (!frame.children.length && text && tag !== "body" && tag !== "html") {
      frame.children.push({
        type: "text",
        name: name + ":inline",
        characters: text,
        fontSize: Math.round(px(cs.fontSize) || 16),
        fontFamily: firstFont(cs),
        color: color(cs.color) || "#111111"
      });
    }
    return frame;
  }

  function capture(mode) {
    var root = mode === "selected" ? selectedElement : document.body;
    if (!root) throw new Error("No selected element. Click Pick element first.");
    captureViewportOnly = mode === "viewport";
    var spec;
    try {
      spec = nodeFor(root, 0, captureViewportOnly ? 18 : 28);
    } finally {
      captureViewportOnly = false;
    }
    if (!spec) throw new Error("Could not capture visible content.");
    spec.name = mode === "selected"
      ? "Chrome selected element - " + (document.title || location.hostname)
      : (mode === "viewport" ? "Chrome viewport - " : "Chrome current tab - ") + (document.title || location.hostname);
    spec.width = Math.max(1, Math.round(root.getBoundingClientRect().width || document.documentElement.clientWidth || window.innerWidth));
    if (mode === "viewport") spec.height = Math.max(1, Math.round(window.innerHeight || spec.height || 800));
    else if (mode !== "selected") spec.height = Math.max(spec.height || 1, Math.round(document.documentElement.scrollHeight || document.body.scrollHeight || window.innerHeight));
    spec._capture = {
      source: "chrome-extension",
      mode: mode,
      url: location.href,
      title: document.title,
      fullPage: mode === "page",
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY }
    };
    return spec;
  }

  function ensureHoverBox() {
    if (hoverBox) return hoverBox;
    hoverBox = document.createElement("div");
    hoverBox.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #b8562b;background:rgba(184,86,43,.08);box-shadow:0 0 0 9999px rgba(0,0,0,.08);";
    document.documentElement.appendChild(hoverBox);
    return hoverBox;
  }

  function setBox(el) {
    var r = el.getBoundingClientRect();
    var box = ensureHoverBox();
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  }

  function startPicker() {
    var onMove = function (ev) {
      if (ev.target && ev.target !== hoverBox) setBox(ev.target);
    };
    var onClick = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      selectedElement = ev.target;
      setBox(selectedElement);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("click", onClick, true);
      setTimeout(function () {
        if (hoverBox) hoverBox.style.boxShadow = "0 0 0 2px rgba(184,86,43,.35)";
      }, 50);
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("click", onClick, true);
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    try {
      if (!msg || msg.type === "FIGBRIDGE_PING") {
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "FIGBRIDGE_PICK_ELEMENT") {
        startPicker();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "FIGBRIDGE_CAPTURE") {
        sendResponse({ ok: true, spec: capture(msg.mode || "page") });
        return;
      }
    } catch (e) {
      sendResponse({ ok: false, error: e && e.message || String(e) });
    }
  });
})();
