// ts-props.js — a minimal, dependency-free reader for React component props
// in TS/TSX source. Just enough for lint_connect to prove that a connect-map
// entry still points at a real export and real props, and that mapped enum
// values are still members of the prop's string-literal union.
//
// Not a TypeScript parser. It understands the shapes component files actually
// use: `interface P { … }` / `type P = … & { … }`, `extends` lists, Omit /
// Pick / Partial, inline `({ … }: { … })` params, forwardRef<El, P>, memo, and
// literal unions — including aliases imported from a relative module and
// `(typeof CONST)[number]` over an `as const` array. Anything it cannot
// resolve is reported as `unresolved`, so callers warn instead of guessing.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const DOM_BASES = /(?:HTMLAttributes|ComponentProps(?:WithoutRef|WithRef)?|HTMLProps|SVGProps|AriaAttributes|DOMAttributes|AllHTMLAttributes)\b/;

// Props every host element accepts; enough to accept `disabled`, `onClick`…
// on a component whose props extend the DOM attributes.
export const DOM_PROPS = new Set([
  "id", "className", "style", "title", "role", "tabIndex", "hidden", "lang", "dir",
  "disabled", "type", "name", "value", "defaultValue", "checked", "defaultChecked",
  "placeholder", "readOnly", "required", "autoFocus", "autoComplete", "maxLength",
  "minLength", "min", "max", "step", "pattern", "multiple", "form", "href", "target",
  "rel", "src", "alt", "width", "height", "children", "onClick", "onChange", "onInput",
  "onFocus", "onBlur", "onKeyDown", "onKeyUp", "onMouseEnter", "onMouseLeave",
  "onPointerDown", "onPointerUp", "onPointerEnter", "onPointerLeave", "onSubmit",
]);

/** Remove // and /* comments, leaving string literals intact. */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") out += "\n"; i++; }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      out += c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] || ""); i += 2; continue; }
        out += src[i]; i++;
      }
      if (i < n) { out += src[i]; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

const OPEN = { "(": ")", "{": "}", "[": "]", "<": ">" };
const CLOSE = new Set([")", "}", "]", ">"]);

function isArrow(s, i) { return s[i] === ">" && s[i - 1] === "="; }

function skipString(s, i) {
  const q = s[i];
  i++;
  while (i < s.length && s[i] !== q) i += s[i] === "\\" ? 2 : 1;
  return i;
}

/** Index of the bracket that closes the one at `i` (any of ( { [ <). */
export function matchBalanced(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "'" || c === '"' || c === "`") { j = skipString(s, j); continue; }
    if (OPEN[c]) depth++;
    else if (CLOSE.has(c) && !isArrow(s, j)) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Split on any char in `seps` at bracket depth 0. */
export function splitTop(s, seps) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (c === "'" || c === '"' || c === "`") {
      const end = skipString(s, j);
      cur += s.slice(j, end + 1);
      j = end;
      continue;
    }
    if (OPEN[c]) depth++;
    else if (CLOSE.has(c) && !isArrow(s, j)) depth--;
    if (depth === 0 && seps.includes(c)) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function esc(name) { return name.replace(/[$]/g, "\\$"); }

/** Names of PascalCase value exports (components), in source order. */
export function listExports(src) {
  const s = stripComments(src);
  const out = [];
  const add = (n) => { if (/^[A-Z]/.test(n) && !out.includes(n)) out.push(n); };
  const re = /export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|class\s+)([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(s))) add(m[1]);
  const listRe = /export\s*\{([^}]*)\}/g;
  while ((m = listRe.exec(s))) {
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (!p || /^type\s/.test(p)) continue;
      const as = p.split(/\s+as\s+/);
      add((as[1] || as[0]).trim());
    }
  }
  return out;
}

/** Does `src` export a value called `name`? ("default" checks a default export.) */
export function hasExport(src, name) {
  const s = stripComments(src);
  if (name === "default") return /export\s+default\b/.test(s);
  return listExports(s).includes(name) ||
    new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s*|const\\s+|let\\s+|var\\s+|class\\s+)${esc(name)}\\b`).test(s);
}

// First parameter's type annotation of the param list opening at `open`.
function firstParamType(s, open) {
  const close = matchBalanced(s, open);
  if (close < 0) return null;
  const params = s.slice(open + 1, close);
  const first = splitTop(params, ",")[0].trim();
  if (!first) return null;
  let rest;
  if (first.startsWith("{")) {
    const end = matchBalanced(first, 0);
    rest = first.slice(end + 1).trim();
  } else {
    const m = /^[A-Za-z_$][\w$]*\??\s*/.exec(first);
    rest = m ? first.slice(m[0].length) : "";
  }
  if (!rest.startsWith(":")) return null;
  // drop a default initialiser (`= {}`) at depth 0
  return splitTop(rest.slice(1), "=")[0].trim() || null;
}

/** The type expression of a component's props, or null. */
export function propsTypeExpr(src, name) {
  const s = stripComments(src);
  let m = new RegExp(`\\bfunction\\s+${esc(name)}\\s*`).exec(s);
  if (m) {
    let i = m.index + m[0].length;
    if (s[i] === "<") i = matchBalanced(s, i) + 1;
    while (/\s/.test(s[i])) i++;
    if (s[i] === "(") {
      const t = firstParamType(s, i);
      if (t) return t;
    }
  }
  m = new RegExp(`\\b(?:const|let|var)\\s+${esc(name)}\\s*(:\\s*[^=]+)?=\\s*`).exec(s);
  if (!m) return null;
  if (m[1]) {
    const fc = /(?:FC|FunctionComponent|ComponentType)\s*</.exec(m[1]);
    if (fc) {
      const open = m[1].indexOf("<", fc.index);
      const inner = m[1].slice(open + 1, matchBalanced(m[1], open));
      return inner.trim();
    }
  }
  let i = m.index + m[0].length;
  const head = s.slice(i, i + 200);
  const fr = /^(?:React\.)?forwardRef\s*</.exec(head);
  if (fr) {
    const open = i + head.indexOf("<");
    const close = matchBalanced(s, open);
    const args = splitTop(s.slice(open + 1, close), ",");
    if (args[1]) return args[1].trim();
    i = close + 1;
  }
  // memo(...) / forwardRef(...) wrappers: find the inner function's params.
  for (let k = 0; k < 4; k++) {
    while (/\s/.test(s[i])) i++;
    const w = /^(?:React\.)?(?:memo|forwardRef)\s*(?:<[^(]*>)?\s*\(/.exec(s.slice(i, i + 120));
    if (w) { i += w[0].length; continue; }
    const fn = /^(?:async\s+)?function\s*[A-Za-z_$]*\s*/.exec(s.slice(i, i + 120));
    if (fn) { i += fn[0].length; if (s[i] === "<") i = matchBalanced(s, i) + 1; while (/\s/.test(s[i])) i++; }
    if (s[i] === "<") { i = matchBalanced(s, i) + 1; while (/\s/.test(s[i])) i++; }
    if (s[i] === "(") return firstParamType(s, i);
    return null;
  }
  return null;
}

// ── Type resolution ─────────────────────────────────────────────────────────

function readModule(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const tries = [base, base + ".ts", base + ".tsx", base + ".d.ts", path.join(base, "index.ts"), path.join(base, "index.tsx")];
  for (const t of tries) {
    try { if (existsSync(t) && !t.endsWith(path.sep)) return { file: t, src: stripComments(readFileSync(t, "utf8")) }; } catch {}
  }
  return null;
}

// Where an identifier comes from when it is imported: { file, src, name }.
function importedFrom(ctx, ident) {
  const re = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(ctx.src))) {
    for (const part of m[2].split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (!p) continue;
      const [orig, alias] = p.split(/\s+as\s+/).map((x) => x.trim());
      if ((alias || orig) === ident) {
        const mod = readModule(ctx.file, m[3]);
        return mod ? { ...mod, name: orig } : null;
      }
    }
  }
  return null;
}

// Text of `type Name = …` (up to the end of the statement), or null.
function typeAliasBody(s, name) {
  const m = new RegExp(`(?:^|[\\s;])(?:export\\s+)?type\\s+${esc(name)}\\s*(<[^=]*>)?\\s*=`).exec(s);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "'" || c === '"' || c === "`") { j = skipString(s, j); continue; }
    if (OPEN[c]) depth++;
    else if (CLOSE.has(c) && !isArrow(s, j)) depth--;
    if (depth === 0 && c === ";") break;
    if (depth === 0 && c === "\n") {
      const before = s.slice(i, j).trim();
      const after = s.slice(j + 1).trimStart();
      if (before && !/[|&=,<(:]$/.test(before) && !/^[|&]/.test(after)) break;
    }
  }
  return s.slice(i, j).trim();
}

function interfaceDecl(s, name) {
  const m = new RegExp(`(?:^|[\\s;])(?:export\\s+)?interface\\s+${esc(name)}\\b`).exec(s);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (s[i] === "<" || /^\s*</.test(s.slice(i, i + 3))) { i = s.indexOf("<", i); i = matchBalanced(s, i) + 1; }
  const open = s.indexOf("{", i);
  if (open < 0) return null;
  const header = s.slice(i, open);
  const ext = /\bextends\b([\s\S]*)$/.exec(header);
  const close = matchBalanced(s, open);
  return { extends: ext ? splitTop(ext[1], ",").map((x) => x.trim()).filter(Boolean) : [], body: s.slice(open + 1, close) };
}

const MEMBER_START = /^\s*(?:readonly\s+)?(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))(\?)?\s*([:(<])/;

function parseMembers(body, out) {
  const chunks = splitTop(body, ";,\n");
  const merged = [];
  for (const ch of chunks) {
    if (!ch.trim()) continue;
    if (MEMBER_START.test(ch) || /^\s*\[/.test(ch) || !merged.length) merged.push(ch);
    else merged[merged.length - 1] += "\n" + ch;
  }
  for (const ch of merged) {
    if (/^\s*\[/.test(ch)) { out.open = true; continue; }
    const m = MEMBER_START.exec(ch);
    if (!m) continue;
    const name = m[2] || m[3];
    let type = ch.slice(m[0].length - 1).trim();
    if (m[5] === ":") type = type.slice(1).trim();
    else type = "function";
    if (!out.members[name]) out.members[name] = { optional: !!m[4], type };
  }
}

function resolveInto(expr, ctx, out, depth) {
  if (depth > 6) { out.unresolved.push(expr.trim()); return; }
  for (let part of splitTop(expr, "&")) {
    part = part.trim();
    if (part.startsWith("(") && matchBalanced(part, 0) === part.length - 1) part = part.slice(1, -1).trim();
    if (!part) continue;
    if (part.startsWith("{")) { parseMembers(part.slice(1, matchBalanced(part, 0)), out); continue; }
    const g = /^([A-Za-z_$][\w$.]*)\s*(<([\s\S]*)>)?$/.exec(part);
    if (!g) { out.unresolved.push(part); continue; }
    const ident = g[1];
    const args = g[3] ? splitTop(g[3], ",").map((x) => x.trim()) : [];
    if (DOM_BASES.test(ident)) { out.inheritsDom = true; continue; }
    if ((ident === "Omit" || ident === "Pick") && args.length === 2) {
      const sub = { members: {}, inheritsDom: false, omitted: new Set(), unresolved: [], open: false };
      resolveInto(args[0], ctx, sub, depth + 1);
      const keys = (literalsOf(args[1], ctx) || []);
      for (const [k, v] of Object.entries(sub.members)) {
        if (ident === "Omit" ? !keys.includes(k) : keys.includes(k)) { if (!out.members[k]) out.members[k] = v; }
      }
      if (ident === "Omit") keys.forEach((k) => out.omitted.add(k));
      if (sub.inheritsDom) out.inheritsDom = true;
      if (sub.open) out.open = true;
      out.unresolved.push(...sub.unresolved);
      continue;
    }
    if (["Partial", "Readonly", "Required", "PropsWithChildren", "React.PropsWithChildren"].includes(ident) && args[0]) {
      if (/PropsWithChildren/.test(ident)) out.members.children = out.members.children || { optional: true, type: "ReactNode" };
      resolveInto(args[0], ctx, out, depth + 1);
      continue;
    }
    const iface = interfaceDecl(ctx.src, ident);
    if (iface) {
      for (const e of iface.extends) resolveInto(e, ctx, out, depth + 1);
      parseMembers(iface.body, out);
      continue;
    }
    const alias = typeAliasBody(ctx.src, ident);
    if (alias) { resolveInto(alias, ctx, out, depth + 1); continue; }
    const imp = importedFrom(ctx, ident);
    if (imp) { resolveInto(imp.name, { file: imp.file, src: imp.src }, out, depth + 1); continue; }
    out.unresolved.push(ident);
  }
}

/**
 * The string-literal members of a type, or null when it is not a pure
 * literal union (e.g. `string`, `boolean`, a ReactNode).
 */
export function literalsOf(typeText, ctx, depth = 0) {
  if (!typeText || depth > 6) return null;
  const vals = [];
  for (let p of splitTop(typeText, "|")) {
    p = p.trim();
    if (!p || p === "undefined" || p === "null") continue;
    const lit = /^'([^']*)'$|^"([^"]*)"$/.exec(p);
    if (lit) { vals.push(lit[1] !== undefined ? lit[1] : lit[2]); continue; }
    const tof = /^\(?\s*typeof\s+([A-Za-z_$][\w$]*)\s*\)?\s*\[\s*number\s*\]$/.exec(p);
    if (tof) {
      const arr = constArray(ctx, tof[1], depth);
      if (!arr) return null;
      vals.push(...arr);
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(p) && ctx) {
      const alias = typeAliasBody(ctx.src, p);
      let sub = alias != null ? literalsOf(alias, ctx, depth + 1) : null;
      if (alias == null) {
        const imp = importedFrom(ctx, p);
        if (imp) {
          const body = typeAliasBody(imp.src, imp.name);
          sub = body != null ? literalsOf(body, { file: imp.file, src: imp.src }, depth + 1) : null;
        }
      }
      if (!sub) return null;
      vals.push(...sub);
      continue;
    }
    return null;
  }
  return vals.length ? vals : null;
}

function constArray(ctx, name, depth) {
  if (!ctx) return null;
  const m = new RegExp(`\\bconst\\s+${esc(name)}\\s*(?::[^=]+)?=\\s*\\[`).exec(ctx.src);
  if (m) {
    const open = m.index + m[0].length - 1;
    const body = ctx.src.slice(open + 1, matchBalanced(ctx.src, open));
    const vals = [];
    for (const item of splitTop(body, ",")) {
      const t = item.trim();
      if (!t) continue;
      const lit = /^'([^']*)'$|^"([^"]*)"$/.exec(t);
      if (!lit) return null;
      vals.push(lit[1] !== undefined ? lit[1] : lit[2]);
    }
    return vals;
  }
  const imp = importedFrom(ctx, name);
  return imp && depth < 6 ? constArray({ file: imp.file, src: imp.src }, imp.name, depth + 1) : null;
}

/**
 * Read a component's props from a source file.
 * @returns {{ found, exported, typeExpr, members, inheritsDom, omitted, open, unresolved, ctx }}
 */
export function readComponentProps(file, exportName) {
  const raw = readFileSync(file, "utf8");
  const ctx = { file, src: stripComments(raw) };
  const res = { found: false, exported: hasExport(raw, exportName), typeExpr: null, members: {}, inheritsDom: false, omitted: new Set(), open: false, unresolved: [], ctx };
  const t = propsTypeExpr(raw, exportName);
  if (!t) return res;
  res.found = true;
  res.typeExpr = t;
  resolveInto(t, ctx, res, 0);
  return res;
}

/** Is `prop` accepted by the component described by `info`? */
export function acceptsProp(info, prop) {
  if (info.members[prop]) return true;
  if (info.omitted.has(prop)) return false;
  if (info.open) return true;
  if (info.inheritsDom && (DOM_PROPS.has(prop) || /^(aria|data)-/.test(prop))) return true;
  return false;
}
