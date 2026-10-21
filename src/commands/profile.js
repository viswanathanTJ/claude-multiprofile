// Choosing which profile Claude Code uses: in this terminal (`switch`) or in every new
// terminal (`set-default`), plus the helpers the shell wrappers call (`resolve-dir`, `shell-init`).
//
// A program cannot change the environment of the shell that started it, so `switch` writes
// the shell line to the file named in CMP_EVAL_FILE. The wrapper from `shell-init` sources it.
// Without the wrapper, `switch` prints the line, so `eval "$(claude-multiprofile switch NAME)"` works.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { select } from "@inquirer/prompts";
import { getRegistry, configDir } from "../registry.js";
import { HOME, ok, info, warn } from "../util.js";
import { detectShell } from "../shell.js";

export const SESSION_VAR = "CLAUDE_MP_PROFILE";
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

// The profile in use here: this terminal's choice, else the saved default.
export function currentProfile() {
  return process.env[SESSION_VAR] || savedDefault();
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

// The shell line that sets this terminal's profile, for the shell in use.
function shellLine(name) {
  const shell = process.env.CMP_SHELL || detectShell();
  return shell === "fish" ? `set -gx ${SESSION_VAR} ${name}` : `export ${SESSION_VAR}=${name}`;
}

// `claude-multiprofile switch [NAME]`: use NAME in this terminal only.
export async function switchCmd(args) {
  const name = args[0] || (await pickProfile("Use which profile in THIS terminal?"));
  requireProfile(name);
  const line = shellLine(name);
  const evalFile = process.env.CMP_EVAL_FILE;
  if (evalFile) {
    fs.writeFileSync(evalFile, `${line}\n`);
    ok(`This terminal now uses ${name}.`);
  } else {
    // No wrapper: print the line for eval, and say how to make it permanent.
    console.log(line);
    info(`Run: eval "$(claude-multiprofile switch ${name})"   (or add the wrapper: claude-multiprofile shell-init)`);
  }
}

// `claude-multiprofile set-default [NAME]`: use NAME in every new terminal.
export async function setDefaultCmd(args) {
  const name = args[0] || (await pickProfile("Use which profile in EVERY new terminal?"));
  requireProfile(name);
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(defaultFile(), `${name}\n`);
  ok(`Default profile is now ${name}. New terminals use it.`);
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

// `claude-multiprofile shell-init [fish|bash|zsh]`: prints the wrapper to add to your shell config.
export function shellInitCmd(args) {
  const shell = args[0] || detectShell();
  const bin = claudeBinary();
  if (shell === "fish") {
    console.log(`# claude-multiprofile wrapper (fish). Put in ~/.config/fish/functions/claude-multiprofile.fish etc.
set -gx CMP_SHELL fish
function claude-multiprofile
    if test "$argv[1]" = switch
        set -lx CMP_EVAL_FILE (mktemp)
        command claude-multiprofile $argv
        if test -s "$CMP_EVAL_FILE"
            source "$CMP_EVAL_FILE"
        end
        rm -f "$CMP_EVAL_FILE"
    else
        command claude-multiprofile $argv
    end
end
function claude --wraps claude
    set -l dir (command claude-multiprofile resolve-dir)
    if test -n "$dir"
        env CLAUDE_CONFIG_DIR="$dir" "${bin}" $argv
    else
        env -u CLAUDE_CONFIG_DIR "${bin}" $argv
    end
end`);
    return;
  }
  // bash and zsh share the same syntax.
  console.log(`# claude-multiprofile wrapper (${shell}). Add to ~/.${shell}rc (or ~/.bash_profile on macOS).
export CMP_SHELL=${shell === "zsh" ? "zsh" : "bash"}
claude-multiprofile() {
  if [ "$1" = switch ]; then
    local f; f="$(mktemp)"
    CMP_EVAL_FILE="$f" command claude-multiprofile "$@"
    [ -s "$f" ] && . "$f"
    rm -f "$f"
  else
    command claude-multiprofile "$@"
  fi
}
claude() {
  local d; d="$(command claude-multiprofile resolve-dir)"
  if [ -n "$d" ]; then CLAUDE_CONFIG_DIR="$d" "${bin}" "$@"; else env -u CLAUDE_CONFIG_DIR "${bin}" "$@"; fi
}`);
}
