// The page of one mesh entity, run inside a VS Code webview. It draws what the extension posts
// and sends back what the user asks for. The extension holds the node, this page only shows.
import { pack, unpack } from "../views/mesh/pack.ts";
import { addElement, fieldAt, getAt, hasMedia, keepEdits, keyOf, mediaIn, parseEdit, removeElement, setAt, tableRows, templateOf } from "../views/mesh/table.ts";
import type { Path, Row, SchemaBlock } from "../views/mesh/table.ts";
import { FrameDecoder, decodeImage } from "./video.ts";
import type { ImageValue } from "./video.ts";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();

type Kind = "topic" | "variable" | "function" | "task";
interface Init {
  kind: Kind;
  name: string;
  value: SchemaBlock | null;
  req: SchemaBlock | null;
  prg: SchemaBlock | null;
  rsp: SchemaBlock | null;
  writable: boolean;
  forceable: boolean;
  cancellable: boolean;
}

const RENDER_MS = 100;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

// Lucide paths, the icons the explorer draws with
const ICON: Record<string, string> = {
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  "undo-2": '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
};
function icon(name: string): SVGElement {
  const holder = document.createElement("span");
  holder.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;
  return holder.firstChild as SVGElement;
}

function button(label: string, onClick: () => void, opts: { primary?: boolean; icon?: string; title?: string } = {}): HTMLButtonElement {
  const b = el("button", { class: opts.primary ? "primary" : "", title: opts.title ?? "" });
  if (opts.icon) b.append(icon(opts.icon));
  if (label) b.append(el("span", {}, label));
  b.addEventListener("click", onClick);
  return b;
}

/** A drawn row, kept while its shape holds so a value change never moves it under the pointer. */
interface Built {
  shape: string;
  el: HTMLElement;
  update(r: Row): void;
}

/** A value as the explorer's Field, Type, Value tree. While editing, the cells edit a draft. */
class Table {
  readonly el = el("div", { class: "tt" });
  value: unknown;
  draft: unknown;
  editing = false;
  readonly edited = new Set<string>();
  readonly bad = new Map<string, string>();
  private readonly open = new Map<string, boolean>();
  private built = new Map<string, Built>();
  private readonly head = el("div", { class: "tt-row tt-head" }, el("span", {}, "Field"), el("span", {}, "Type"), el("span", {}, "Value"));
  private pending: ReturnType<typeof setTimeout> | undefined;
  private readonly block: SchemaBlock | null;
  /** The draft takes new values from the mesh where the user changed nothing, as a variable does. */
  private readonly follows: boolean;
  private readonly changed: () => void;

  constructor(block: SchemaBlock | null, follows: boolean, changed: () => void) {
    this.block = block;
    this.follows = follows;
    this.changed = changed;
    this.el.addEventListener("focusout", () => this.schedule());
  }

  /** A new value from the mesh. */
  show(v: unknown): void {
    this.value = v;
    if (this.editing && this.follows) this.draft = keepEdits(structuredClone(v), this.draft, this.edited);
    this.schedule();
  }

  edit(on: boolean, from?: unknown): void {
    this.editing = on;
    this.draft = on ? structuredClone(from ?? this.value ?? templateOf(this.block)) : undefined;
    this.edited.clear();
    this.bad.clear();
    this.render();
    this.changed();
  }

  undo(): void {
    this.edit(this.editing, this.follows ? this.value : templateOf(this.block));
  }

  current(): unknown {
    return this.editing ? this.draft : this.value;
  }

  private schedule(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.render();
    }, RENDER_MS);
  }

  private commit(key: string, path: Path, value: unknown): void {
    this.draft = setAt(this.draft, path, value);
    this.edited.add(key);
    this.bad.delete(key);
    this.render();
    this.changed();
  }

  private toggle(key: string, open: boolean): void {
    this.open.set(key, !open);
    this.render();
  }

  render(): void {
    // never rebuild a text field being typed in: its change lands when it is left
    const typing = document.activeElement;
    if (typing instanceof HTMLInputElement && this.el.contains(typing)) return;
    const v = this.current();
    if (v === undefined && !this.editing) {
      this.built.clear();
      this.el.replaceChildren(el("div", { class: "placeholder" }, "no value yet"));
      return;
    }
    const rows = tableRows(this.block, v, { open: this.open, editing: this.editing });
    const next = new Map<string, Built>();
    const els: HTMLElement[] = [this.head];
    rows.forEach((r, i) => {
      const shape = JSON.stringify([r.depth, r.name, r.type, r.branch, r.open, r.editor, r.options ?? [], !!r.remove, !!r.add, r.more ?? 0, i % 2, this.edited.has(r.key), this.bad.get(r.key) ?? ""]);
      let b = this.built.get(r.key);
      if (b && b.shape === shape) b.update(r);
      else b = this.build(r, i, shape);
      next.set(r.key, b);
      els.push(b.el);
    });
    this.built = next;
    // the rows are only put in again when they changed, so a click in progress keeps its row
    const kids = this.el.children;
    if (kids.length !== els.length || els.some((e, i) => kids[i] !== e)) this.el.replaceChildren(...els);
  }

  private build(r: Row, i: number, shape: string): Built {
    const field = el("span", { class: "c-field" });
    field.style.paddingLeft = `${4 + r.depth * 14}px`;
    const caret = el("span", { class: "caret" });
    if (r.branch) caret.append(icon(r.open ? "chevron-down" : "chevron-right"));
    if (r.add) caret.append(icon("plus"));
    field.append(caret, el("span", { class: "name" }, r.name));
    if (r.remove) {
      const x = el("span", { class: "remove", title: "Remove" }, icon("x"));
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        this.draft = removeElement(this.draft, r.path);
        this.edited.add(keyOf(r.path.slice(0, -1)));
        this.render();
        this.changed();
      });
      field.append(x);
    }
    const cell = this.cell(r);
    const line = el("div", { class: `tt-row${r.branch ? " branch" : ""}${i % 2 ? " odd" : ""}${r.add ? " add" : ""}` }, field, el("span", { class: "c-type" }, r.type), cell.el);
    // a branch folds from anywhere on its row, the name first of all
    if (r.branch) line.addEventListener("click", () => this.toggle(r.key, r.open));
    if (r.add && this.block) line.addEventListener("click", () => {
      this.draft = addElement(this.block!, this.draft, r.path);
      this.edited.add(keyOf(r.path));
      this.open.set(keyOf(r.path), true);
      this.render();
      this.changed();
    });
    return { shape, el: line, update: cell.update };
  }

  private cell(first: Row): { el: HTMLElement; update(r: Row): void } {
    let r = first;
    const cell = el("span", { class: `c-value${this.edited.has(r.key) ? " edited" : ""}` });
    if (!r.editor || !this.block) {
      const text = el("span", { class: r.more ? "faint" : "" }, r.text);
      cell.append(text);
      return { el: cell, update: (n) => void (text.textContent = n.text) };
    }
    const { kind, row } = fieldAt(this.block, r.path);
    if (r.editor === "bool") {
      const label = el("span", {}, r.text);
      const sw = el("button", { class: `switch${r.text === "true" ? " on" : ""}` }, el("span", { class: "knob" }));
      sw.addEventListener("click", () => this.commit(r.key, r.path, r.text !== "true"));
      cell.append(label, sw);
      return {
        el: cell,
        update: (n) => {
          r = n;
          label.textContent = n.text;
          sw.classList.toggle("on", n.text === "true");
        },
      };
    }
    if (r.editor === "enum") {
      const select = el("select");
      for (const o of r.options ?? []) select.append(el("option", { value: o }, o));
      select.value = r.text;
      select.addEventListener("change", () => this.commit(r.key, r.path, select.value));
      cell.append(select);
      return {
        el: cell,
        update: (n) => {
          r = n;
          if (document.activeElement !== select) select.value = n.text;
        },
      };
    }
    const input = el("input", { type: "text", spellcheck: "false" });
    input.value = r.edit;
    const why = this.bad.get(r.key);
    if (why) {
      input.classList.add("bad");
      input.title = why;
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") {
        input.value = r.edit;
        input.blur();
      }
    });
    input.addEventListener("change", () => {
      const parsed = parseEdit(kind, input.value, row);
      if (parsed.ok) this.commit(r.key, r.path, parsed.value);
      else {
        this.bad.set(r.key, parsed.why);
        input.classList.add("bad");
        input.title = parsed.why;
        this.changed();
      }
    });
    cell.append(input);
    return {
      el: cell,
      update: (n) => {
        r = n;
        if (document.activeElement !== input) input.value = n.edit;
      },
    };
  }
}

/** The pictures in a value, wherever they sit, each decoded in order. */
class Previews {
  readonly el = el("div", { class: "previews" });
  private readonly items = new Map<string, { type: "VideoFrame" | "Image"; canvas: HTMLCanvasElement; note: HTMLElement; decoder: FrameDecoder; busy: boolean }>();
  private readonly block: SchemaBlock | null;

  constructor(block: SchemaBlock | null) {
    this.block = block;
  }

  private draw(item: { canvas: HTMLCanvasElement; note: HTMLElement }, pic: VideoFrame | ImageBitmap): void {
    const w = "displayWidth" in pic ? pic.displayWidth : pic.width;
    const h = "displayHeight" in pic ? pic.displayHeight : pic.height;
    if (item.canvas.width !== w || item.canvas.height !== h) {
      item.canvas.width = w;
      item.canvas.height = h;
    }
    item.canvas.getContext("2d")?.drawImage(pic, 0, 0);
    item.note.textContent = "";
  }

  feed(value: unknown): void {
    for (const m of mediaIn(this.block, value)) {
      const v = getAt(value, m.path) as { data?: Uint8Array; codec?: string } | undefined;
      if (!v || !v.data?.length) continue;
      let item = this.items.get(m.key);
      if (!item) {
        const canvas = el("canvas");
        const note = el("div", { class: "note" }, "waiting for a frame");
        const name = m.path.map((p, i) => (typeof p === "number" ? `[${p}]` : i ? `.${p}` : p)).join("");
        if (name) this.el.append(el("figure", {}, canvas, el("figcaption", {}, name), note));
        else this.el.append(el("figure", {}, canvas, note));
        item = { type: m.type, canvas, note, decoder: new FrameDecoder(), busy: false };
        this.items.set(m.key, item);
      }
      const it = item;
      if (it.type === "Image") {
        // a still picture needs nothing before it, so a busy decode lets this one go
        if (it.busy) continue;
        it.busy = true;
        decodeImage(v as unknown as ImageValue)
          .then((bmp) => {
            this.draw(it, bmp);
            bmp.close();
          })
          .catch((e: unknown) => (it.note.textContent = String(e instanceof Error ? e.message : e)))
          .finally(() => (it.busy = false));
        continue;
      }
      // every video frame goes to the decoder in order, since most only hold changes
      it.decoder
        .decode(v)
        .then((f) => {
          if (f) this.draw(it, f);
          else it.note.textContent = it.decoder.error || `waiting for a ${v.codec ?? ""} keyframe`;
        })
        .catch((e: unknown) => (it.note.textContent = String(e instanceof Error ? e.message : e)));
    }
  }
}

const status = el("div", { class: "status" });
const stats = el("span", { class: "stats" });
let main: Table | undefined;
let request: Table | undefined;
let progress: Table | undefined;
let result: Table | undefined;
let previews: Previews | undefined;
const resultHead = el("div", { class: "info" });
const actions = el("div", { class: "actions" });
let actionsShown = "";
let running = false;
let setup: Init | undefined;

function section(title: string, ...kids: Node[]): HTMLElement {
  return el("section", {}, el("h2", {}, title), ...kids);
}

/** The buttons of the head, by kind and by what the user is doing. Redrawn only when that changes. */
function drawActions(): void {
  const s = setup;
  if (!s) return;
  const bad = (t?: Table) => !!t && t.bad.size > 0;
  const state = JSON.stringify([main?.editing, main?.edited.size, bad(main), bad(request), running]);
  if (state === actionsShown) return;
  actionsShown = state;
  const out: HTMLElement[] = [];
  if (s.kind === "topic" && s.value && main) {
    if (!main.editing) out.push(button("Compose", () => main!.edit(true, main!.value ?? templateOf(s.value)), { icon: "pencil" }));
    else {
      out.push(button("", () => main!.edit(false), { icon: "x", title: "Stop composing" }));
      out.push(button("", () => main!.undo(), { icon: "undo-2", title: "Undo the changes" }));
      const send = button("Send", () => vscode.postMessage({ type: "publish", value: pack(main!.draft) }), { primary: true });
      send.disabled = bad(main);
      out.push(send);
    }
  }
  if (s.kind === "variable" && s.writable && main) {
    const undo = button("", () => main!.undo(), { icon: "undo-2", title: "Undo the changes" });
    undo.disabled = main.edited.size === 0;
    const set = button("Set", () => {
      vscode.postMessage({ type: "set", value: pack(main!.draft), force: false });
      main!.edit(true, main!.draft);
    }, { primary: true });
    set.disabled = main.edited.size === 0 || bad(main);
    out.push(undo, set);
    if (s.forceable) {
      out.push(button("Force", () => vscode.postMessage({ type: "set", value: pack(main!.draft), force: true })));
      out.push(button("Release", () => vscode.postMessage({ type: "unforce" })));
    }
  }
  if ((s.kind === "function" || s.kind === "task") && request) {
    if (s.kind === "task" && running) {
      const cancel = button("Cancel", () => vscode.postMessage({ type: "cancel" }));
      cancel.disabled = !s.cancellable;
      out.push(cancel);
    } else {
      const call = button(s.kind === "task" ? "Run" : "Call", () => vscode.postMessage({ type: "call", value: pack(request!.draft) }), { primary: true });
      call.disabled = bad(request) || running;
      out.push(call);
    }
  }
  actions.replaceChildren(...out);
}

/** The head as rant sub prints it: the name, who sends, how fast and how many. */
function drawStats(m: { from: string; hz: number; seen: number; age: number }): void {
  const parts = [`from ${m.from}`, `${m.hz.toFixed(1)} Hz`, `${m.seen} ${m.seen === 1 ? "message" : "messages"}`];
  if (m.age > 1) parts.push(`last ${m.age.toFixed(1)} s ago`);
  stats.textContent = parts.join("  ");
}

function init(s: Init): void {
  setup = s;
  actionsShown = "";
  const block = s.kind === "function" || s.kind === "task" ? s.req : s.value;
  const name = el("h1", { title: `${s.kind} of ${block?.name || "bytes"}` }, s.name);
  const parts: Node[] = [el("header", {}, name, stats, actions), status];
  if (s.kind === "topic" || s.kind === "variable") {
    main = new Table(s.value, s.kind === "variable", drawActions);
    if (s.kind === "variable" && s.writable && s.value) main.editing = true;
    // with pictures the table is a sidebar beside them, without it takes the whole page
    if (hasMedia(s.value)) {
      previews = new Previews(s.value);
      parts.push(el("div", { class: "split" }, previews.el, el("aside", {}, main.el)));
    } else parts.push(main.el);
    main.render();
  } else {
    request = new Table(s.req, false, drawActions);
    request.edit(true, templateOf(s.req));
    parts.push(section("Request", request.el));
    if (s.kind === "task") {
      progress = new Table(s.prg, false, () => {});
      parts.push(section("Progress", progress.el));
    }
    result = new Table(s.rsp, false, () => {});
    parts.push(section("Result", resultHead, result.el));
  }
  document.body.replaceChildren(...parts);
  drawActions();
}

window.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as Record<string, unknown> & { type: string };
  switch (m.type) {
    case "init":
      init(m as unknown as Init);
      break;
    case "status":
      status.textContent = String(m.text);
      break;
    case "stats":
      drawStats(m as unknown as { from: string; hz: number; seen: number; age: number });
      break;
    case "value": {
      const v = unpack(m.value);
      if (main && !main.editing && main.value === undefined && setup?.kind === "variable" && setup.writable) main.edit(true, v);
      main?.show(v);
      previews?.feed(v);
      if (setup?.kind === "variable") drawActions();
      break;
    }
    case "progress":
      progress?.show(m.value === null ? undefined : unpack(m.value));
      break;
    case "running":
      running = !!m.on;
      if (running) progress?.show(undefined);
      drawActions();
      break;
    case "result":
      resultHead.textContent = String(m.head);
      resultHead.className = m.ok ? "info" : "info error";
      result?.show(m.value === undefined ? undefined : unpack(m.value));
      break;
  }
});

vscode.postMessage({ type: "ready" });
