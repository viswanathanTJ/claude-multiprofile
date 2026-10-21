// Choosing which profile Claude Code uses. The choice is global: `switch` (or `set-default`)
// saves it, and the `claude` command reads it on every start, in every terminal.
// `resolve-dir` and `shell-init` are the helpers the `claude` wrapper uses.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { select } from "@inquirer/prompts";
import { getRegistry, configDir } from "../registry.js";
import { HOME, ok, info, warn } from "../util.js";
import { detectShell, rcPathForShell } from "../shell.js";

const DEFAULT = "default";

// The profiles that can be chosen: the normal ~/.claude account, then every Claude Code
// profile in the registry.
export function listProfiles() {
  const profiles = [{ name: DEFAULT, configDir: path.join(HOME, ".claude") }];
  for (const p of getRegistry().profiles) {
    if (p.code?.configDir) profiles.push({ name: p.name, configDir: p.code.configDir });
  }
  return profiles;
}

function defaultFile() {
  return path.join(configDir(), "default");
}

// The profile saved with set-default (DEFAULT when none is saved).
export function savedDefault() {
  try {
    return fs.readFileSync(defaultFile(), "utf8").trim() || DEFAULT;
  } catch {
    return DEFAULT;
  }
}

// The profile in use: the saved choice (global for every terminal).
export function currentProfile() {
  return savedDefault();
}

function findNamed(name) {
  return listProfiles().find((p) => p.name === name);
}

function requireProfile(name) {
  const found = findNamed(name);
  if (!found) {
    const names = listProfiles().map((p) => p.name).join(", ");
    throw new Error(`No profile named "${name}". Profiles: ${names}.`);
  }
  return found;
}

// Asks which profile to use. The line in use now is marked with *.
async function pickProfile(question) {
  const current = currentProfile();
  return select({
    message: question,
    choices: listProfiles().map((p) => ({
      name: `${p.name === current ? "*" : " "} ${p.name.padEnd(12)} ${p.configDir}`,
      value: p.name,
    })),
    pageSize: 10,
  });
}

// Saves NAME as the profile for every terminal.
function saveDefault(name) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(defaultFile(), `${name}\n`);
}

// `claude-multiprofile switch [NAME]`: the claude command uses NAME everywhere, from now on.
export async function switchCmd(args) {
  const name = args[0] || (await pickProfile("Switch Claude Code to which profile? (applies to every terminal)"));
  requireProfile(name);
  saveDefault(name);
  ok(`Claude Code now uses ${name} in every terminal.`);
}

// `claude-multiprofile set-default [NAME]`: use NAME in every new terminal.
// Same as switch; kept as a name for the same thing.
export async function setDefaultCmd(args) {
  return switchCmd(args);
}

// `claude-multiprofile current`: the profile in use here.
export function currentCmd() {
  console.log(currentProfile());
}

// `claude-multiprofile resolve-dir`: the config folder for the profile in use ("" for default).
// The shell wrapper calls this on every `claude` start.
export function resolveDirCmd() {
  const name = currentProfile();
  const found = findNamed(name);
  if (!found) {
    warn(`Profile "${name}" no longer exists; using the default account.`);
    console.log("");
    return;
  }
  console.log(name === DEFAULT ? "" : found.configDir);
}

// Path of the real claude program, for the wrappers to call.
function claudeBinary() {
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || "claude";
  } catch {
    return "claude";
  }
}

// The `claude` wrapper text for one shell. It asks `resolve-dir` on every start, so a switch applies
// right away in every terminal.
function wrapperText(shell, bin) {
  if (shell === "fish") {
    return `# claude-multiprofile: the claude command follows the profile chosen with switch (fish).
function claude --wraps claude
    set -l dir (command claude-multiprofile resolve-dir)
    if test -n "$dir"
        env CLAUDE_CONFIG_DIR="$dir" "${bin}" $argv
    else
        env -u CLAUDE_CONFIG_DIR "${bin}" $argv
    end
end
`;
  }
  // bash and zsh share the same syntax.
  return `# claude-multiprofile: the claude command follows the profile chosen with switch (${shell}).
claude() {
  local d; d="$(command claude-multiprofile resolve-dir)"
  if [ -n "$d" ]; then CLAUDE_CONFIG_DIR="$d" "${bin}" "$@"; else env -u CLAUDE_CONFIG_DIR "${bin}" "$@"; fi
}
`;
}

// Its own marked block, so it never collides with the alias block the tool writes (which it replaces whole).
const RC_START = "# >>> claude-multiprofile wrapper >>>";
const RC_END = "# <<< claude-multiprofile wrapper <<<";

// `claude-multiprofile shell-init [fish|bash|zsh] [--install]`.
// Without --install it prints the wrapper. With --install it writes it into the shell's config file
// (config.fish, .zshrc or .bash_profile) as a marked block; an older block is replaced.
export function shellInitCmd(args) {
  const install = args.includes("--install");
  const shell = args.find((a) => a !== "--install") || detectShell();
  if (!["fish", "bash", "zsh"].includes(shell)) throw new Error(`Unknown shell "${shell}". Use fish, bash or zsh.`);
  const text = wrapperText(shell, claudeBinary());
  if (!install) {
    console.log(text);
    return;
  }
  const rc = rcPathForShell(shell);
  const block = `${RC_START}\n${text}${RC_END}\n`;
  let current = "";
  try {
    current = fs.readFileSync(rc, "utf8");
  } catch {
    current = "";
  }
  const start = current.indexOf(RC_START);
  const end = current.indexOf(RC_END);
  const next = start !== -1 && end > start
    ? current.slice(0, start) + block + current.slice(end + RC_END.length).replace(/^\n/, "")
    : current + (current && !current.endsWith("\n") ? "\n" : "") + block;
  fs.writeFileSync(rc, next);
  ok(`Installed the claude wrapper in ${rc}`);
}
