import type { TreeNode } from "./tree.ts";

export type Action = "build" | "start" | "stop" | "restart";
export type PresetKind = "workspace" | "package" | "node" | "group";
export type Language = "cpp" | "python" | "csharp";

export const PRESET_KINDS: ReadonlyArray<{ kind: PresetKind; detail: string }> = [
  { kind: "workspace", detail: "A folder with a talker, a listener and a group of both" },
  { kind: "package", detail: "A build folder with one node, Rant added" },
  { kind: "node", detail: "One more node in the package around the folder" },
  { kind: "group", detail: "A group file that starts nodes together" },
];

export const LANGUAGES: readonly Language[] = ["cpp", "python", "csharp"];

/** The CLI arguments for an action on a row, or undefined when the action does not fit the row. */
export function actionArgs(action: Action, row: Pick<TreeNode, "kind" | "ref">): string[] | undefined {
  const { kind, ref } = row;
  switch (action) {
    case "build":
      return kind === "workspace" ? ["build"] : kind === "package" ? ["build", ref] : undefined;
    case "start":
      return kind === "node" ? ["run", "node", ref] : kind === "group" ? ["run", ref] : undefined;
    case "stop":
      return kind === "workspace" ? ["stop", "-y"] : kind === "node" || kind === "group" ? ["stop", ref, "-y"] : undefined;
    case "restart":
      return kind === "workspace" ? ["restart"] : kind === "node" || kind === "group" ? ["restart", ref] : undefined;
  }
}

/** The arguments of `rant new` for a preset. A node or group takes the language of its package. */
export function newArgs(kind: PresetKind, name: string, language?: Language): string[] {
  const lang = kind === "workspace" || kind === "package" ? ["--lang", language ?? "python"] : [];
  return ["new", kind, name, ...lang, "-y"];
}

/** A name `rant new` accepts as a folder, node or group name. */
export function validName(name: string): string | undefined {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(name) ? undefined : "Start with a letter, then letters, digits, _ or -";
}
