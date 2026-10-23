// Sharing between Claude Code profiles: `claude-multiprofile link`, and the same question in `add`.
//
// Folders are linked, so both profiles use one copy and a change in either shows in both:
//   history  projects/, history.jsonl, file-history/
//   setup    skills/, commands/, agents/, hooks/, output-styles/, CLAUDE.md, keybindings.json
//
// What lives inside <config dir>/.claude.json cannot be linked, because the same file holds the
// profile's own account, onboarding state and caches. Those parts are copied, and only added:
// what the target already has is kept.
//   mcp      MCP servers, user scope (`mcpServers`) and each folder's local scope
//            (`projects[folder].mcpServers`, where `claude mcp add` puts them by default)
//   prefs    onboarding done, theme, and each folder's trust and allowed tools
//   mcpAuth  the MCP servers' OAuth sign-ins (`mcpOAuth` in .credentials.json). Asked apart:
//            both profiles then hold the same refresh token, and when one refreshes, the
//            other can be signed out of that server and has to authenticate again.
//
// Never shared: the Claude sign-in (`claudeAiOauth`) and account (`oauthAccount`), which are what
// make a profile a different account, and settings.json, which often holds per-profile env.
//
// The default profile keeps .claude.json next to its folder (~/.claude.json), not inside it.
// On macOS the sign-ins are in the Keychain, not in .credentials.json, so mcpAuth is Linux only.

import fs from "node:fs";
import path from "node:path";
import { HOME, isMac } from "./util.js";
import { linkEntries, SHARED_HISTORY } from "./history.js";

export const DEFAULT_DIR = path.join(HOME, ".claude");

export const SETUP_LINKS = ["skills", "commands", "agents", "hooks", "output-styles", "CLAUDE.md", "keybindings.json"];

const PREF_KEYS = ["hasCompletedOnboarding", "lastOnboardingVersion", "theme", "editorMode"];
const PROJECT_PREF_KEYS = [
  "hasTrustDialogAccepted",
  "allowedTools",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "hasClaudeMdExternalIncludesApproved",
  "hasClaudeMdExternalIncludesWarningShown",
];

export const SHARE_ITEMS = [
  { value: "history", name: "Chat history (projects, history.jsonl, file-history): linked", checked: true },
  { value: "setup", name: "Skills, commands, agents, hooks, output styles, CLAUDE.md, keybindings: linked", checked: true },
  { value: "mcp", name: "MCP servers, user and per-folder: copied, the target's own are kept", checked: true },
  { value: "prefs", name: "Onboarding, theme, per-folder trust and allowed tools: copied", checked: true },
  { value: "mcpAuth", name: "MCP sign-ins (tokens): copied; a shared token can sign the other profile out", checked: true },
];

export function mcpAuthSupported() {
  return !isMac();
}

// <config dir>/.claude.json, or ~/.claude.json for the default profile.
export function userConfigFileFor(dir, { home = HOME } = {}) {
  return path.resolve(dir) === path.join(home, ".claude") ? path.join(home, ".claude.json") : path.join(dir, ".claude.json");
}

export function credentialsFileFor(dir) {
  return path.join(dir, ".credentials.json");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`Cannot read ${file}: ${e.message}`);
  }
}

// Writes through a temporary file so Claude never reads half a file, keeping the file's mode
// (0600 for a new one: both files can hold secrets).
function writeJson(file, data) {
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // New file.
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Adds the servers of `from` that `to` lacks. Returns [added, kept] names.
function mergeServers(from, to) {
  const added = [];
  const kept = [];
  for (const [name, def] of Object.entries(from || {})) {
    if (!(name in to)) {
      to[name] = def;
      added.push(name);
    } else if (!same(to[name], def)) {
      kept.push(name);
    }
  }
  return [added, kept];
}

// Copies MCP server definitions, user and local scope. Pure: takes and returns parsed configs.
export function mergeMcp(src, dst) {
  const out = { ...dst };
  const notes = [];
  out.mcpServers = { ...(dst.mcpServers || {}) };
  const [added, kept] = mergeServers(src.mcpServers, out.mcpServers);
  if (added.length) notes.push(`MCP servers (all folders): added ${added.join(", ")}`);
  if (kept.length) notes.push(`MCP servers (all folders): kept the target's own ${kept.join(", ")}`);
  if (!Object.keys(out.mcpServers).length) delete out.mcpServers;

  for (const [folder, proj] of Object.entries(src.projects || {})) {
    if (!proj?.mcpServers || !Object.keys(proj.mcpServers).length) continue;
    out.projects = { ...(out.projects || {}) };
    const target = { ...(out.projects[folder] || {}) };
    target.mcpServers = { ...(target.mcpServers || {}) };
    const [a, k] = mergeServers(proj.mcpServers, target.mcpServers);
    out.projects[folder] = target;
    if (a.length) notes.push(`MCP servers in ${folder}: added ${a.join(", ")}`);
    if (k.length) notes.push(`MCP servers in ${folder}: kept the target's own ${k.join(", ")}`);
  }
  return { config: out, notes };
}

// Copies onboarding, theme and each folder's trust. Only keys the target does not have.
export function mergePrefs(src, dst) {
  const out = { ...dst };
  const copied = [];
  for (const key of PREF_KEYS) {
    if (key in src && !(key in out)) {
      out[key] = src[key];
      copied.push(key);
    }
  }
  let folders = 0;
  for (const [folder, proj] of Object.entries(src.projects || {})) {
    const keys = PROJECT_PREF_KEYS.filter((k) => proj && k in proj);
    if (!keys.length) continue;
    out.projects = { ...(out.projects || {}) };
    const target = { ...(out.projects[folder] || {}) };
    let changed = false;
    for (const k of keys) {
      if (!(k in target)) {
        target[k] = proj[k];
        changed = true;
      }
    }
    out.projects[folder] = target;
    if (changed) folders++;
  }
  const notes = [];
  if (copied.length) notes.push(`Preferences: copied ${copied.join(", ")}`);
  if (folders) notes.push(`Preferences: trust and allowed tools for ${folders} folder${folders === 1 ? "" : "s"}`);
  return { config: out, notes };
}

// Copies the MCP OAuth sign-ins the target does not have. Never touches claudeAiOauth.
export function mergeMcpAuth(src, dst) {
  const out = { ...dst };
  const added = [];
  const from = src.mcpOAuth || {};
  if (Object.keys(from).length) out.mcpOAuth = { ...(dst.mcpOAuth || {}) };
  for (const [key, tok] of Object.entries(from)) {
    if (!(key in out.mcpOAuth)) {
      out.mcpOAuth[key] = tok;
      added.push(key.split("|")[0]);
    }
  }
  return { credentials: out, notes: added.length ? [`MCP sign-ins: copied ${added.join(", ")}`] : [] };
}

// Shares `items` (values of SHARE_ITEMS) from the profile in `fromDir` to the one in `toDir`.
// Returns one line per change, for the user.
//
// fresh: `toDir` was created by this run, so setup copies in it are replaced rather than moved aside.
export function share(fromDir, toDir, items, { fresh = false, home = HOME } = {}) {
  const want = new Set(items);
  const notes = [];
  if (want.has("history")) notes.push(...linkEntries(fromDir, toDir, SHARED_HISTORY, { create: true }));
  if (want.has("setup")) notes.push(...linkEntries(fromDir, toDir, SETUP_LINKS, { replace: fresh }));

  if (want.has("mcp") || want.has("prefs")) {
    const srcFile = userConfigFileFor(fromDir, { home });
    const dstFile = userConfigFileFor(toDir, { home });
    const src = readJson(srcFile) || {};
    let dst = readJson(dstFile) || {};
    const before = JSON.stringify(dst);
    if (want.has("mcp")) {
      const r = mergeMcp(src, dst);
      dst = r.config;
      notes.push(...r.notes);
    }
    if (want.has("prefs")) {
      const r = mergePrefs(src, dst);
      dst = r.config;
      notes.push(...r.notes);
    }
    if (JSON.stringify(dst) !== before) {
      fs.mkdirSync(path.dirname(dstFile), { recursive: true });
      if (fs.existsSync(dstFile)) fs.copyFileSync(dstFile, `${dstFile}.before-sharing`);
      writeJson(dstFile, dst);
    } else {
      notes.push("MCP servers and preferences: nothing to add");
    }
  }

  if (want.has("mcpAuth")) {
    if (!mcpAuthSupported()) {
      notes.push("MCP sign-ins: kept in the macOS Keychain, not copied; run /mcp in the profile to authenticate");
    } else {
      const src = readJson(credentialsFileFor(fromDir));
      if (!src?.mcpOAuth || !Object.keys(src.mcpOAuth).length) {
        notes.push("MCP sign-ins: the source has none");
      } else {
        const dstFile = credentialsFileFor(toDir);
        const dst = readJson(dstFile) || {};
        const r = mergeMcpAuth(src, dst);
        if (r.notes.length) {
          writeJson(dstFile, r.credentials);
          fs.chmodSync(dstFile, 0o600);
          notes.push(...r.notes);
        } else {
          notes.push("MCP sign-ins: the target already has them");
        }
      }
    }
  }
  return notes;
}
