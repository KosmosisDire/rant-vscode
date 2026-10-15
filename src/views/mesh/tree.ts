import type { EntityKind, MeshEntity, Peer } from "rant-client";

import { rttText } from "./format.ts";

export type MeshItem =
  | { kind: "section"; id: string; label: string; children: MeshItem[] }
  | { kind: "folder"; id: string; label: string; description: string; children: MeshItem[] }
  | { kind: "peer"; id: string; label: string; description: string; tooltip: string; peer: Peer }
  | { kind: "entity"; id: string; label: string; description: string; tooltip: string; entity: MeshEntity };

const SECTIONS: { kind: EntityKind; label: string }[] = [
  { kind: "topic", label: "Topics" },
  { kind: "variable", label: "Variables" },
  { kind: "function", label: "Functions" },
  { kind: "task", label: "Tasks" },
];

/** Rant's own nodes and entities: the CLI's short lived nodes, logs and meta. */
export const builtIn = (name: string) => name.startsWith("@rant/");

function counts(e: MeshEntity): string {
  switch (e.kind) {
    case "topic":
      return `${e.providers} pub, ${e.consumers} sub`;
    case "variable":
      return `${e.consumers} remote`;
    default:
      return `${e.providers} provider${e.providers === 1 ? "" : "s"}`;
  }
}

function entityItem(e: MeshEntity, id: string, label: string): MeshItem {
  const type = e.schema?.name ?? "bytes";
  const flags = [e.conflict ? "type conflict" : "", e.incomplete ? "incomplete" : ""].filter(Boolean);
  const lines = [`${e.kind} ${e.name}`, `type ${type}${e.rsp ? ` to ${e.rsp.name}` : ""}`, counts(e), e.reliable ? "reliable" : "best effort", ...flags];
  return { kind: "entity", id, label, description: [type, counts(e), ...flags].join(", "), tooltip: lines.join("\n"), entity: e };
}

interface Dir {
  dirs: Map<string, Dir>;
  leaves: { label: string; entity: MeshEntity }[];
}

function size(d: Dir): number {
  let n = d.leaves.length;
  for (const sub of d.dirs.values()) n += size(sub);
  return n;
}

/** Entities as folders split on `/`, a folder holding only one folder merged into it. scope keeps ids apart. */
export function nest(entities: MeshEntity[], scope: string): MeshItem[] {
  const root: Dir = { dirs: new Map(), leaves: [] };
  for (const e of entities) {
    const segs = e.name.split("/").filter(Boolean);
    let at = root;
    for (const s of segs.slice(0, -1)) {
      let next = at.dirs.get(s);
      if (!next) at.dirs.set(s, (next = { dirs: new Map(), leaves: [] }));
      at = next;
    }
    at.leaves.push({ label: segs[segs.length - 1] ?? e.name, entity: e });
  }
  const items = (d: Dir, path: string): MeshItem[] => {
    const folders = [...d.dirs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, sub]): MeshItem => {
      let label = name;
      while (sub.leaves.length === 0 && sub.dirs.size === 1) {
        const [only, next] = [...sub.dirs.entries()][0]!;
        label += `/${only}`;
        sub = next;
      }
      const at = path ? `${path}/${label}` : label;
      return { kind: "folder", id: `${scope}/dir/${at}`, label, description: String(size(sub)), children: items(sub, at) };
    });
    const leaves = [...d.leaves]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((l) => entityItem(l.entity, `${scope}/${l.entity.kind}/${l.entity.name}`, l.label));
    return [...folders, ...leaves];
  };
  return items(root, "");
}

function peerItem(p: Peer): MeshItem {
  // a round trip shows only once one was measured, never the hop to the bridge alone
  const rtt = p.rtt.samples ? rttText(p.rtt.us) : "";
  const state = p.active ? (p.missed > 1 ? `missed ${p.missed}` : rtt) : "gone";
  return {
    kind: "peer",
    id: `peer/${p.id}`,
    label: p.name || `peer ${p.id}`,
    description: state,
    tooltip: [`${p.name} (${p.id})`, p.address, rtt ? `round trip ${rtt}, jitter ${rttText(p.rtt.jitterUs) || "0 ms"}` : "no round trip measured"].join("\n"),
    peer: p,
  };
}

/** The mesh view's rows: the nodes, then the entities by kind, each a tree of their names. */
export function buildMesh(peers: Peer[], entities: MeshEntity[]): MeshItem[] {
  const out: MeshItem[] = [
    {
      kind: "section",
      id: "nodes",
      label: "Nodes",
      children: peers
        .filter((p) => !builtIn(p.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(peerItem),
    },
  ];
  for (const s of SECTIONS) {
    const list = entities.filter((e) => e.kind === s.kind && !builtIn(e.name));
    if (list.length) out.push({ kind: "section", id: s.kind, label: s.label, children: nest(list, s.kind) });
  }
  return out;
}
