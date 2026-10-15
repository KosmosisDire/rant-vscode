import type { MeshEntity, Peer } from "rant-client";

import type { WorkspaceData } from "../../workspaces/load.ts";

/** A node row: on the mesh (peer), started by a workspace (root and ref), or both. */
export interface NodeItem {
  kind: "node";
  id: string;
  label: string;
  description: string;
  tooltip: string;
  /** joining: a workspace started it and it is not on the mesh yet. */
  state: "up" | "joining";
  peer?: Peer;
  root?: string;
  ref: string;
}

export type MeshItem =
  | { kind: "section"; id: string; label: string; children: MeshItem[] }
  | { kind: "folder"; id: string; label: string; children: MeshItem[] }
  | { kind: "group"; id: string; label: string; description: string; tooltip: string; root: string; ref: string; children: MeshItem[] }
  | NodeItem
  | { kind: "entity"; id: string; label: string; description: string; tooltip: string; entity: MeshEntity };

/** What the Mesh view needs of a workspace: what it started, and under which groups. */
export type Started = Pick<WorkspaceData, "root" | "name" | "listing">;

/** A round trip in microseconds as a short text. */
export function rttText(us: number): string {
  if (us <= 0) return "";
  return us < 10000 ? `${(us / 1000).toFixed(1)} ms` : `${Math.round(us / 1000)} ms`;
}

/** Rant's own nodes and entities: the CLI's short lived nodes, logs and meta. */
export const builtIn = (name: string) => name.startsWith("@rant/");

/** Nodes that only look at the mesh: Rant's own, editors and the explorer. */
const tooling = (name: string) => builtIn(name) || name === "vscode" || name === "explorer";

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
  // a bare type has no name, so its kind stands in, such as f64
  const type = e.schema ? e.schema.name || e.schema.fields[0]?.kind || "value" : "bytes";
  const flags = [e.conflict ? "type conflict" : "", e.incomplete ? "incomplete" : ""].filter(Boolean);
  const lines = [`${e.kind} ${e.name}`, `type ${type}${e.rsp ? ` to ${e.rsp.name}` : ""}`, counts(e), e.reliable ? "reliable" : "best effort", ...flags];
  return { kind: "entity", id, label, description: [type, counts(e), ...flags].join(", "), tooltip: lines.join("\n"), entity: e };
}

interface Dir {
  dirs: Map<string, Dir>;
  leaves: { label: string; entity: MeshEntity }[];
}

/** Entities as a tree split on `/`, one segment a level, folders first, the way the explorer shows them. */
/** A node's own entities count only its own side, so each takes the mesh's row of the same entity when there is one. */
export function meshCounts(own: MeshEntity[], mesh: MeshEntity[]): MeshEntity[] {
  const byName = new Map(mesh.map((e) => [`${e.kind} ${e.name}`, e]));
  return own.map((e) => byName.get(`${e.kind} ${e.name}`) ?? e);
}

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
  const items = (d: Dir, path: string): MeshItem[] => [
    ...[...d.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sub]): MeshItem => {
        const at = path ? `${path}/${name}` : name;
        return { kind: "folder", id: `${scope}/dir/${at}`, label: `${name}/`, children: items(sub, at) };
      }),
    ...[...d.leaves]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((l) => entityItem(l.entity, `${scope}/${l.entity.kind}/${l.entity.name}`, l.label)),
  ];
  return items(root, "");
}

function nodeItem(id: string, name: string, peer: Peer | undefined, root?: string): NodeItem {
  // a round trip shows only once one was measured, never the hop to the bridge alone
  const rtt = peer?.rtt.samples ? rttText(peer.rtt.us) : "";
  const state = peer ? "up" : "joining";
  const lines = [name, peer ? peer.address : "started, not on the mesh yet"];
  if (rtt) lines.push(`round trip ${rtt}, jitter ${rttText(peer?.rtt.jitterUs ?? 0) || "0 ms"}`);
  if (root) lines.push(`started by ${root}`);
  return {
    kind: "node",
    id,
    label: name,
    description: !peer ? "joining" : peer.missed > 1 ? `missed ${peer.missed}` : rtt,
    tooltip: lines.join("\n"),
    state,
    peer,
    root,
    ref: name,
  };
}

/**
 * The Mesh view's rows. Nodes come under each running group they belong to, a node of two
 * groups under both, then the nodes of no group. A started node matches its peer by name,
 * since the CLI starts it under its instance name. Entities follow as one tree of names.
 */
export function buildMesh(peers: Peer[], entities: MeshEntity[], started: Started[]): MeshItem[] {
  const visible = peers.filter((p) => p.active && !tooling(p.name));
  const live = new Map(visible.map((p) => [p.name, p]));
  const byName = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
  const groups: MeshItem[] = [];
  const loose: NodeItem[] = [];
  const claimed = new Set<string>();
  const several = started.length > 1;
  for (const w of started) {
    for (const g of w.listing.runningGroups) {
      const members = w.listing.nodes.filter((n) => n.running && n.groups.includes(g));
      const id = `group/${w.root}/${g}`;
      groups.push({
        kind: "group",
        id,
        label: g,
        description: several ? w.name : "",
        tooltip: `${g}, started by ${w.root}`,
        root: w.root,
        ref: g,
        children: members.map((n) => nodeItem(`${id}/${n.name}`, n.name, live.get(n.name), w.root)).sort(byName),
      });
      members.forEach((n) => claimed.add(n.name));
    }
    for (const n of w.listing.nodes.filter((x) => x.running && x.groups.length === 0)) {
      loose.push(nodeItem(`node/${w.root}/${n.name}`, n.name, live.get(n.name), w.root));
      claimed.add(n.name);
    }
  }
  // several peers may share a name, each its own row
  for (const p of visible) if (!claimed.has(p.name)) loose.push(nodeItem(`peer/${p.id}`, p.name, p));

  const out: MeshItem[] = [{ kind: "section", id: "nodes", label: "Nodes", children: [...groups.sort(byName), ...loose.sort(byName)] }];
  const shown = entities.filter((e) => !builtIn(e.name));
  if (shown.length) out.push({ kind: "section", id: "entities", label: "Entities", children: nest(shown, "entities") });
  return out;
}
