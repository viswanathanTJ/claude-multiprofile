// `claude-multiprofile login [list | save NAME | use NAME | NAME | remove NAME] [--profile P] [--force]`:
// several Claude accounts in one profile, switched without touching its history or setup.
// With no subcommand it asks which saved login to use. See src/logins.js.

import { select } from "@inquirer/prompts";
import { resolveProfile } from "./profile.js";
import { listLogins, saveLogin, useLogin, removeLogin, requireLoginFiles } from "../logins.js";
import { ok, info, warn, pathStr, tildify, command } from "../util.js";

const SUBCOMMANDS = ["list", "save", "use", "remove"];

function printList(profile, logins) {
  info(`Saved logins in ${profile.name} (${pathStr(tildify(profile.configDir))}):`);
  if (!logins.length) {
    info(`  none yet. Sign in with /login in claude, then: ${command("claude-multiprofile login save NAME")}`);
    return;
  }
  for (const l of logins) {
    const who = [l.email, l.org].filter(Boolean).join(", ");
    console.log(`  ${l.active ? "*" : " "} ${l.name.padEnd(14)} ${who}`);
  }
  if (!logins.some((l) => l.active)) info("  (the account signed in now is not saved)");
}

export async function login(args) {
  let profileName = null;
  let force = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--profile") profileName = args[++i];
    else if (a.startsWith("--profile=")) profileName = a.slice("--profile=".length);
    else if (a === "--force" || a === "-f") force = true;
    else rest.push(a);
  }
  requireLoginFiles();
  const profile = resolveProfile(profileName);
  const dir = profile.configDir;

  let [sub, name] = rest;
  // `login NAME` is short for `login use NAME`.
  if (sub && !SUBCOMMANDS.includes(sub)) [sub, name] = ["use", sub];

  if (sub === "list") return printList(profile, listLogins(dir));
  if (sub === "save") {
    if (!name) throw new Error("Usage: claude-multiprofile login save NAME");
    for (const line of saveLogin(dir, name, { replace: force })) ok(line);
    return;
  }
  if (sub === "remove") {
    if (!name) throw new Error("Usage: claude-multiprofile login remove NAME");
    for (const line of removeLogin(dir, name)) ok(line);
    return;
  }

  if (!name) {
    const logins = listLogins(dir);
    if (!logins.length) return printList(profile, logins);
    name = await select({
      message: `Sign ${profile.name} in as:`,
      choices: logins.map((l) => ({ name: `${l.active ? "*" : " "} ${l.name.padEnd(14)} ${l.email || ""}`, value: l.name })),
      pageSize: 10,
    });
  }
  const notes = useLogin(dir, name, { force });
  for (const line of notes.slice(0, -1)) info(line);
  ok(notes[notes.length - 1]);
  if (notes.length > 1) {
    warn("Claude sessions already open keep the account they started with. Restart them; one that refreshes its sign-in can write its old account back.");
  }
}
