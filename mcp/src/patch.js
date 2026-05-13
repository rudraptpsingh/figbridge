// Pillar 1, part 2 — generate_patch.
//
// Takes a diff_to_source result (or just its `changes` array) plus a
// sourceDir on disk, and produces a minimal patch plan:
//   - For text-content changes (`field: "characters"`), grep matching
//     HTML files for the old string and swap to the new one.
//   - For color / fontSize / fontFamily changes: emit a structured note
//     pointing at the CSS file most likely to own the rule. The agent
//     (or the user) is the final arbiter for style swaps because they
//     usually need a token edit, not a literal replacement.
//
// Output:
//   { ok, edits: [{ file, before, after, hunkPreview }],
//     notes: [{ name, field, figma, source, hint }],
//     unifiedDiff: "—— full preview as a single string ——" }
//
// Pure deterministic, no LLM. Idempotent: edits[].before is the exact
// substring; running the same patch twice produces zero hits the second
// time. No files are written — caller decides.

import { promises as fs } from "node:fs";
import path from "node:path";

const TEXT_FILE_EXT = new Set([".html", ".htm", ".jsx", ".tsx", ".js", ".ts", ".vue", ".svelte", ".astro", ".njk", ".md"]);
const STYLE_FILE_EXT = new Set([".css", ".scss", ".sass", ".less", ".styl"]);

async function walk(dir, depth, files) {
  if (depth < 0) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "build") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, depth - 1, files);
    else files.push(full);
  }
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

async function findOccurrences(files, needle, extSet) {
  const hits = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (extSet && !extSet.has(ext)) continue;
    let buf;
    try { buf = await fs.readFile(f, "utf8"); } catch { continue; }
    if (!buf.includes(needle)) continue;
    const idx = buf.indexOf(needle);
    const before = buf.slice(Math.max(0, idx - 40), idx);
    const after = buf.slice(idx + needle.length, idx + needle.length + 40);
    hits.push({ file: f, snippet: before + "⟪" + needle + "⟫" + after, count: buf.split(needle).length - 1 });
  }
  return hits;
}

function unifiedHunk(file, before, after) {
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `- ${before}`,
    `+ ${after}`,
    "",
  ].join("\n");
}

export async function generatePatch({ changes, sourceDir }) {
  if (!sourceDir) return { ok: false, error: "sourceDir is required" };
  if (!Array.isArray(changes)) return { ok: false, error: "changes must be an array" };

  const allFiles = [];
  await walk(sourceDir, 4, allFiles);

  const edits = [];
  const notes = [];
  const diffChunks = [];

  for (const ch of changes) {
    if (ch.field === "characters") {
      const oldStr = ch.source;
      const newStr = ch.figma;
      if (!oldStr || typeof oldStr !== "string" || oldStr.length < 2) {
        notes.push({ ...ch, hint: "string too short or empty — skipped" });
        continue;
      }
      const hits = await findOccurrences(allFiles, oldStr, TEXT_FILE_EXT);
      if (!hits.length) {
        notes.push({ ...ch, hint: `no occurrence of "${oldStr}" found in ${sourceDir}` });
        continue;
      }
      // Take the unambiguous (single-hit) edit; otherwise warn.
      const total = hits.reduce((a, h) => a + h.count, 0);
      if (total > 1) {
        notes.push({ ...ch, hint: `ambiguous: "${oldStr}" appears ${total}× across ${hits.length} file(s); review before applying`, files: hits.map(h => h.file) });
      }
      for (const hit of hits) {
        const rel = path.relative(sourceDir, hit.file);
        edits.push({
          file: rel,
          field: "characters",
          before: oldStr,
          after: newStr,
          context: hit.snippet,
        });
        diffChunks.push(unifiedHunk(rel, oldStr, newStr));
      }
    } else if (ch.field === "color" || ch.field === "fontSize" || ch.field === "fontFamily") {
      // Style swaps usually mean "change the token". Surface a hint and
      // suggest CSS files the user can grep instead of auto-editing.
      const styleFiles = allFiles.filter(f => STYLE_FILE_EXT.has(path.extname(f).toLowerCase()));
      notes.push({
        ...ch,
        hint: `style change — review token vs literal. Candidate files: ${styleFiles.slice(0, 5).map(f => path.relative(sourceDir, f)).join(", ") || "(none)"}`,
      });
    } else {
      notes.push({ ...ch, hint: "presence-only change — manual review" });
    }
  }

  return {
    ok: true,
    sourceDir,
    editCount: edits.length,
    noteCount: notes.length,
    edits,
    notes,
    unifiedDiff: diffChunks.join("\n"),
  };
}
