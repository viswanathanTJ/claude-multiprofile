// Saved logins: several Claude accounts in one Claude Code folder. `claude-multiprofile login`.
//
// A profile keeps its history, settings, MCP servers and everything else; only the account changes.
// The account is two parts:
//   claudeAiOauth  the sign-in, in <config dir>/.credentials.json
//   oauthAccount   the account it shows, in .claude.json (~/.claude.json for the default profile)
// Each saved login holds both, in <config dir>/logins/<name>.json (0600, folder 0700).
//
// Claude refreshes its tokens while it runs, so a login saved in the morning can be stale by the
// afternoon. `use` therefore saves the account signed in now under its name before switching away,
// and only switches from an account that is saved (or with force). The other parts of
// .credentials.json (MCP sign-ins) are left alone.
//
// Linux only: on macOS the sign-in is in the Keychain.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "./util.js";
import { credentialsInFiles, credentialsFileFor, userConfigFileFor, readJson, writeJson } from "./share.js";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function requireLoginFiles() {
  if (!credentialsInFiles()) throw new Error("Saved logins are Linux only: macOS keeps the Claude sign-in in the Keychain.");
}

export function loginsDirFor(dir) {
  return path.join(dir, "logins");
}

function loginFile(dir, name) {
  return path.join(loginsDirFor(dir), `${name}.json`);
}

export function checkLoginName(name) {
  if (!name || !NAME_RE.test(name)) throw new Error(`"${name || ""}" is not a usable login name: letters, digits, dot, dash, underscore.`);
  return name;
}

// The same account: by account and organisation when both sides know them, else by refresh token.
export function sameAccount(a, b) {
  const ida = a.oauthAccount?.accountUuid, idb = b.oauthAccount?.accountUuid;
  if (ida && idb) return ida === idb && (a.oauthAccount.organizationUuid || "") === (b.oauthAccount.organizationUuid || "");
  const ra = a.claudeAiOauth?.refreshToken, rb = b.claudeAiOauth?.refreshToken;
  return Boolean(ra && rb && ra === rb);
}

// The account signed in now in the profile at `dir`.
export function currentLogin(dir, { home = HOME } = {}) {
  const creds = readJson(credentialsFileFor(dir)) || {};
  const cfg = readJson(userConfigFileFor(dir, { home })) || {};
  return { claudeAiOauth: creds.claudeAiOauth || null, oauthAccount: cfg.oauthAccount || null };
}

export function readLogin(dir, name) {
  return readJson(loginFile(dir, name));
}

function writeLogin(dir, name, login) {
  const folder = loginsDirFor(dir);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.chmodSync(folder, 0o700);
  const file = loginFile(dir, name);
  writeJson(file, { claudeAiOauth: login.claudeAiOauth, oauthAccount: login.oauthAccount, savedAt: new Date().toISOString() });
  fs.chmodSync(file, 0o600);
}

// Saved logins, by name, each with `active` when it is the account signed in now.
export function listLogins(dir, { home = HOME } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(loginsDirFor(dir)).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const now = currentLogin(dir, { home });
  return names.map((name) => {
    const login = readLogin(dir, name) || {};
    return {
      name,
      email: login.oauthAccount?.emailAddress || null,
      org: login.oauthAccount?.organizationName || null,
      active: Boolean(now.claudeAiOauth) && sameAccount(login, now),
    };
  });
}

// The name the account signed in now is saved under, or null.
export function activeLoginName(dir, { home = HOME } = {}) {
  return listLogins(dir, { home }).find((l) => l.active)?.name || null;
}

// Saves the account signed in now as `name`. Saving it again under the same name refreshes it; an
// account already saved under another name, or another account under this name, is refused.
export function saveLogin(dir, name, { home = HOME, replace = false } = {}) {
  checkLoginName(name);
  const now = currentLogin(dir, { home });
  if (!now.claudeAiOauth) throw new Error("Nothing to save: this profile is not signed in. Run claude and /login first.");
  const other = listLogins(dir, { home }).find((l) => l.active && l.name !== name);
  if (other) throw new Error(`This account is already saved as "${other.name}".`);
  const old = readLogin(dir, name);
  if (old && !sameAccount(old, now) && !replace) {
    throw new Error(`"${name}" is another account (${old.oauthAccount?.emailAddress || "unknown"}). Remove it first, or pass --force to replace it.`);
  }
  writeLogin(dir, name, now);
  const who = now.oauthAccount?.emailAddress ? ` (${now.oauthAccount.emailAddress})` : "";
  return [old ? `Login "${name}"${who}: updated` : `Login "${name}"${who}: saved`];
}

// Signs the profile at `dir` in as the saved login `name`. The account signed in now is saved
// under its own name first, so its latest tokens are kept. force: switch away from an account
// that is not saved (its sign-in is dropped).
export function useLogin(dir, name, { home = HOME, force = false } = {}) {
  checkLoginName(name);
  const target = readLogin(dir, name);
  if (!target) {
    const names = listLogins(dir, { home }).map((l) => l.name);
    throw new Error(`No saved login named "${name}".${names.length ? ` Saved: ${names.join(", ")}.` : " Save one with: claude-multiprofile login save NAME"}`);
  }
  if (!target.claudeAiOauth) throw new Error(`Saved login "${name}" holds no sign-in.`);
  const notes = [];
  const now = currentLogin(dir, { home });
  if (now.claudeAiOauth) {
    const from = activeLoginName(dir, { home });
    if (from === name) {
      writeLogin(dir, name, now);
      return [`Already signed in as "${name}".`];
    }
    if (from) {
      writeLogin(dir, from, now);
      notes.push(`Login "${from}": kept its latest sign-in`);
    } else if (!force) {
      const who = now.oauthAccount?.emailAddress || "the account signed in now";
      throw new Error(`${who} is not saved, and switching would drop it. Save it first (claude-multiprofile login save NAME), or pass --force.`);
    } else {
      notes.push("The account signed in before was not saved; it was dropped");
    }
  }

  const credsFile = credentialsFileFor(dir);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(credsFile, { ...(readJson(credsFile) || {}), claudeAiOauth: target.claudeAiOauth });
  fs.chmodSync(credsFile, 0o600);

  const cfgFile = userConfigFileFor(dir, { home });
  const cfg = { ...(readJson(cfgFile) || {}) };
  if (target.oauthAccount) cfg.oauthAccount = target.oauthAccount;
  else delete cfg.oauthAccount;
  writeJson(cfgFile, cfg);

  const who = target.oauthAccount?.emailAddress ? ` (${target.oauthAccount.emailAddress})` : "";
  notes.push(`Signed in as "${name}"${who}`);
  return notes;
}

export function removeLogin(dir, name) {
  checkLoginName(name);
  const file = loginFile(dir, name);
  if (!fs.existsSync(file)) throw new Error(`No saved login named "${name}".`);
  fs.rmSync(file);
  return [`Login "${name}": removed (the account signed in now is unchanged)`];
}
