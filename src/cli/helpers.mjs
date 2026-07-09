// Small shared CLI utilities — no state, no side effects beyond printing.

import { infoLine, warnLine } from "../ui.mjs";
import { providerKeyMissing, providerKeyEnvVar, SETTINGS_PATH } from "../core/config.mjs";

// Mask a secret for display: nvapi-1…WxYz
export function maskKey(k) {
  if (!k) return "(none)";
  if (k.length <= 10) return "****";
  return k.slice(0, 6) + "…" + k.slice(-4);
}

export function normalizeProviderKey(name) {
  return String(name || "").trim().toLowerCase();
}

export function modelKeyFor(providerName, id) {
  const safe = String(id).replace(/^models\//, "").replace(/[^a-zA-Z0-9._:-]+/g, "-");
  return `${providerName}/${safe}`;
}

export function trimHealthMessage(message) {
  return String(message || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

// Inject a skill's instructions as a system message, then queue the user's args.
export async function applySkill(skill, arg, msgs, sess) {
  msgs.push({ role: "system", content: `# Skill: ${skill.name}\n${skill.body}` });
  const userMsg = arg
    ? `Run the "${skill.name}" skill. Arguments: ${arg}`
    : `Run the "${skill.name}" skill.`;
  msgs.push({ role: "user", content: userMsg });
  await sess.append({ type: "skill", skill: skill.name, arg });
}

// Rebuild the in-memory message list from a saved session's records.
export function restoreSessionMessages(records, msgs) {
  for (const rec of records) {
    if (rec.type === "user") {
      msgs.push({ role: "user", content: rec.content });
    } else if (rec.type === "assistant" && rec.message) {
      msgs.push(rec.message);
    } else if (rec.type === "tool" && rec.tool_call_id) {
      msgs.push({
        role: "tool",
        tool_call_id: rec.tool_call_id,
        content: typeof rec.result === "string" ? rec.result : JSON.stringify(rec.result),
      });
    }
  }
}

// Print setup guidance when the active model's provider has no API key.
// Returns true if a key is missing.
export function reportMissingKey(model) {
  if (!providerKeyMissing(model)) return false;
  const prov = model.providerName;
  warnLine(`No API key configured for provider "${prov}".`);
  infoLine("Set one of:");
  infoLine(`  • in the REPL:   /apikey ${prov} <your-key>`);
  infoLine(`  • env variable:  ${providerKeyEnvVar(prov)}=<your-key>`);
  infoLine(`  • edit:          ${SETTINGS_PATH}`);
  if (prov === "nvidia") infoLine("Get a free NVIDIA NIM key at https://build.nvidia.com");
  return true;
}

// Parse "100k" / "1.5m" / "250000" into a token count (null if unparseable).
export function parseTokenBudget(text) {
  const m = String(text || "").trim().match(/^(\d+(?:\.\d+)?)([km])?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = m[2] ? (m[2].toLowerCase() === "k" ? 1e3 : 1e6) : 1;
  return Math.round(n * mult);
}
