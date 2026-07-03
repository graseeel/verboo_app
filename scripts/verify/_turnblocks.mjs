// src/renderer/features/transcript/turnBlocks.ts
var KIND_MAP = {
  read: "read",
  search: "search",
  edit: "edit",
  command: "command",
  terminal: "terminal",
  permission: "permission",
  subagent: "agent-open",
  tool: "tool"
};
function groupTurnBlocks(items) {
  const blocks = [];
  for (const item of items) {
    if (item.kind === "activity") {
      if (item.activityKind === "thinking") continue;
      const action = {
        kind: KIND_MAP[item.activityKind ?? "tool"] ?? "tool",
        label: item.text,
        detail: item.activityDetail,
        command: item.command ?? (item.activityKind === "command" ? { input: item.activityDetail ?? item.text, output: "", status: "success" } : void 0)
      };
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "actions") last.actions.push(action);
      else blocks.push({ kind: "actions", id: `${item.id}:g`, actions: [action] });
      continue;
    }
    if (item.role === "assistant") {
      blocks.push({ kind: "text", id: item.id, text: item.text, streaming: Boolean(item.streaming) });
    }
  }
  return blocks;
}
var PLURAL = {
  read: ["Leu arquivo", "Leu arquivos"],
  search: ["Pesquisou", "Pesquisou"],
  edit: ["Editou arquivo", "Editou arquivos"],
  create: ["Criou arquivo", "Criou arquivos"],
  delete: ["Apagou arquivo", "Apagou arquivos"],
  command: ["Executou comando", "Executou comandos"],
  terminal: ["Leu terminal", "Leu terminal"],
  permission: ["Pediu permiss\xE3o", "Pediu permiss\xF5es"],
  "agent-open": ["Criou um agente", "Criou agentes"],
  "agent-close": ["Fechou um agente", "Fechou agentes"],
  tool: ["Usou ferramenta", "Usou ferramentas"]
};
function summarizeActions(actions) {
  const counts = /* @__PURE__ */ new Map();
  for (const a of actions) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  const parts = [];
  for (const [kind, n] of counts) {
    const forms = PLURAL[kind] ?? ["A\xE7\xE3o", "A\xE7\xF5es"];
    parts.push(n === 1 ? forms[0] : `${forms[1]} (${n})`);
  }
  if (parts.length <= 1) return parts[0] ?? "Trabalhou";
  return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}
export {
  groupTurnBlocks,
  summarizeActions
};
