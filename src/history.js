// Sharing folders and files between Claude Code profiles by linking them.
//
// Claude Code keeps its history in the profile's config folder: the `projects` folder (one
// transcript per session), `history.jsonl` (the prompt history) and `file-history` (the file
// checkpoints /rewind uses). Sharing links those entries from one profile to another, so both
// see the same history. `link` uses the same code for setup folders (skills, commands, ...).
// The source keeps its files. A copy that the target already had is moved aside, never deleted.

import fs from "node:fs";
import path from "node:path";

export const SHARED_HISTORY = ["projects", "history.jsonl", "file-history"];

// Entries that are files; every other entry is a folder.
const FILE_ENTRIES = new Set(["history.jsonl", "CLAUDE.md", "keybindings.json"]);

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// Links each entry of `toDir` to the same entry of `fromDir`. Returns one line per entry, for the user.
//
// The link points at where the source entry really is, so linking a profile to one that is itself
// linked does not make a chain, and linking two profiles that already share an entry (in either
// direction) is a no-op rather than a loop.
//
// create: make a missing source entry (empty) instead of skipping it. History wants this, so both
//   profiles write to one place from the start; setup items that do not exist are simply skipped.
// replace: delete what the target had instead of moving it aside. Only for a folder this run created.
export function linkEntries(fromDir, toDir, entries, { create = false, replace = false } = {}) {
  if (realOrNull(fromDir) && realOrNull(fromDir) === realOrNull(toDir)) {
    throw new Error(`Source and target are the same folder: ${fromDir}`);
  }
  const notes = [];
  fs.mkdirSync(toDir, { recursive: true });
  for (const item of entries) {
    const src = path.join(fromDir, item);
    const dst = path.join(toDir, item);
    const isDir = !FILE_ENTRIES.has(item);
    if (!fs.existsSync(src)) {
      if (!create) {
        notes.push(`${item}: not in the source, skipped`);
        continue;
      }
      fs.mkdirSync(fromDir, { recursive: true });
      if (isDir) fs.mkdirSync(src);
      else fs.writeFileSync(src, "");
    }
    const target = fs.realpathSync(src);
    let existing = null;
    try {
      existing = fs.lstatSync(dst);
    } catch {
      existing = null;
    }
    if (existing) {
      if (realOrNull(dst) === target) {
        notes.push(`${item}: already shared`);
        continue;
      }
      if (replace) {
        fs.rmSync(dst, { recursive: true, force: true });
      } else {
        const backup = `${dst}.before-sharing-${stamp()}`;
        fs.renameSync(dst, backup);
        notes.push(`${item}: the old copy was kept as ${backup}`);
      }
    }
    fs.symlinkSync(target, dst, isDir ? "dir" : "file");
    notes.push(`${item}: shared with ${fromDir}`);
  }
  return notes;
}

// Links the history of `toDir` to `fromDir`.
export function linkHistory(fromDir, toDir, opts = {}) {
  return linkEntries(fromDir, toDir, SHARED_HISTORY, { create: true, ...opts });
}
