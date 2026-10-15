import type { EntityKind, MeshEntity, Peer } from "rant-client";

import { rttText } from "./format.ts";

export type MeshItem =
  | { kind: "section"; id: string; label: string; children: MeshItem[] }
  | { kind: "peer"; id: string; label: string; description: string; tooltip: string; peer: Peer }
  | { kind: "entity"; id: string; label: string; description: string; tooltip: string; entity: MeshEntity };

const SECTIONS: { kind: EntityKind; label: string }[] = [
  { kind: "topic", label: "Topics" },
  { kind: "variable", label: "Variables" },
  { kind: "function", label: "Functions" },
  { kind: "task", label: "Tasks" },
];

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

/** One entity row. scope keeps ids apart when the same entity shows under several parents. */
export function entityItem(e: MeshEntity, scope: string): MeshItem {
  const type = e.schema?.name ?? "bytes";
  const flags = [e.conflict ? "type conflict" : "", e.incomplete ? "incomplete" : ""].filter(Boolean);
  const lines = [`${e.kind} ${e.name}`, `type ${type}${e.rsp ? ` to ${e.rsp.name}` : ""}`, counts(e), e.reliable ? "reliable" : "best effort", ...flags];
  return {
    kind: "entity",
    id: `${scope}/${e.kind}/${e.name}`,
    label: e.name,
    description: [type, counts(e), ...flags].join(", "),
    tooltip: lines.join("\n"),
    entity: e,
  };
}

function peerItem(p: Peer): MeshItem {
  const rtt = rttText(p.rtt.us);
  const state = p.active ? (p.missed > 1 ? `missed ${p.missed}` : rtt) : "gone";
  return {
    kind: "peer",
    id: `peer/${p.id}`,
    label: p.name || `peer ${p.id}`,
    description: state,
    tooltip: [
      `${p.name} (${p.id})`,
      p.address,
      rtt ? `round trip ${rtt}, jitter ${rttText(p.rtt.jitterUs) || "0 ms"}` : "no round trip yet",
      `between the bridge and the node ${rttText(p.meshRtt.us) || "unknown"}`,
    ].join("\n"),
    peer: p,
  };
}

/** Rant's own entities, logs and meta. The logs have their own channel. */
export const builtIn = (e: MeshEntity) => e.name.startsWith("@rant/");

/** The mesh view's rows: the nodes, then the entities by kind, each sorted by name. */
export function buildMesh(peers: Peer[], entities: MeshEntity[]): MeshItem[] {
  const byName = <T>(key: (x: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));
  const out: MeshItem[] = [
    {
      kind: "section",
      id: "nodes",
      label: "Nodes",
      children: [...peers].sort(byName((p) => p.name)).map(peerItem),
    },
  ];
  for (const s of SECTIONS) {
    const list = entities.filter((e) => e.kind === s.kind && !builtIn(e)).sort(byName((e) => e.name));
    if (list.length) out.push({ kind: "section", id: s.kind, label: s.label, children: list.map((e) => entityItem(e, "mesh")) });
  }
  return out;
}
