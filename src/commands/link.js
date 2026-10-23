// `claude-multiprofile link [SOURCE] [TARGET] [--items LIST] [--yes]`: share history, setup,
// MCP servers and preferences from one Claude Code profile to another. Asks for whatever is
// left out. See src/share.js for what each item does.

import { select, checkbox, confirm } from "@inquirer/prompts";
import { listProfiles } from "./profile.js";
import { share, SHARE_ITEMS, mcpAuthSupported } from "../share.js";
import { ok, info, warn, pathStr, tildify } from "../util.js";

const ITEM_VALUES = SHARE_ITEMS.map((i) => i.value);

function findProfile(name) {
  const found = listProfiles().find((p) => p.name === name);
  if (!found) {
    const names = listProfiles().map((p) => p.name).join(", ");
    throw new Error(`No profile named "${name}". Profiles: ${names}.`);
  }
  return found;
}

function parseItems(text) {
  const items = text.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = items.filter((i) => !ITEM_VALUES.includes(i));
  if (unknown.length) throw new Error(`Unknown item: ${unknown.join(", ")}. Items: ${ITEM_VALUES.join(", ")}.`);
  return items;
}

// The items to share, asked as a checklist. MCP sign-ins are confirmed apart, with what they cost.
export async function askShareItems(sourceName) {
  const choices = SHARE_ITEMS.filter((i) => i.value !== "mcpAuth" || mcpAuthSupported());
  const items = await checkbox({ message: `Share what from ${sourceName}?`, choices, pageSize: choices.length });
  if (items.includes("mcpAuth")) {
    const sure = await confirm({
      message:
        "Copy MCP sign-ins? Both profiles will hold the same refresh tokens; when one refreshes, the other may need /mcp → Authenticate again.",
      default: false,
    });
    if (!sure) return items.filter((i) => i !== "mcpAuth");
  }
  return items;
}

export async function link(args) {
  let items = null;
  let yes = false;
  const names = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--items") items = parseItems(args[++i] || "");
    else if (a.startsWith("--items=")) items = parseItems(a.slice("--items=".length));
    else if (a === "--yes" || a === "-y") yes = true;
    else names.push(a);
  }

  const profiles = listProfiles();
  const label = (p) => `${p.name.padEnd(12)} ${p.configDir}`;
  const source = names[0]
    ? findProfile(names[0])
    : findProfile(await select({ message: "Share from which profile (source)?", choices: profiles.map((p) => ({ name: label(p), value: p.name })) }));
  const targets = profiles.filter((p) => p.name !== source.name);
  if (!targets.length) throw new Error("There is no other profile to share with. Create one with: claude-multiprofile add");
  const target = names[1]
    ? findProfile(names[1])
    : findProfile(await select({ message: "Share into which profile (target)?", choices: targets.map((p) => ({ name: label(p), value: p.name })) }));
  if (target.name === source.name) throw new Error("Source and target are the same profile.");

  if (!items) items = await askShareItems(source.name);
  if (!items.length) {
    warn("Nothing chosen. Nothing was changed.");
    return;
  }

  info(`From ${source.name} (${pathStr(tildify(source.configDir))}) into ${target.name} (${pathStr(tildify(target.configDir))}): ${items.join(", ")}`);
  if (target.name === "default") warn("The target is your default profile: its own copies are moved aside, not deleted.");
  info("Close Claude in the target profile first: it rewrites its .claude.json while it runs.");
  if (!yes && !(await confirm({ message: "Apply?", default: true }))) {
    warn("Cancelled. Nothing was changed.");
    return;
  }
  for (const line of share(source.configDir, target.configDir, items)) info(line);
  ok(`${target.name} now shares ${items.join(", ")} with ${source.name}.`);
}
