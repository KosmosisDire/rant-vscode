// The entity page: draws what the extension posts and sends back what the user asks for.
const vscode = acquireVsCodeApi();

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "onclick") e.addEventListener("click", v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

const status = el("div", { class: "status" });
const valueInfo = el("div", { class: "info" });
const value = el("pre", { class: "value" });
const progress = el("pre", { class: "value" });
const resultHead = el("div", { class: "info" });
const result = el("pre", { class: "value" });
const input = el("textarea", { rows: "8", spellcheck: "false" });
let cancel;

function section(title, ...children) {
  return el("section", {}, el("h2", {}, title), ...children);
}

function init(m) {
  const send = (msg) => vscode.postMessage({ ...msg, text: input.value });
  input.value = m.template;
  const parts = [
    el("h1", {}, el("span", { class: "kind" }, m.kind), " ", m.name),
    el("details", {}, el("summary", {}, "Type"), el("pre", {}, m.schema)),
    status,
  ];
  if (m.kind === "topic" || m.kind === "variable") parts.push(section("Value", valueInfo, value));
  const buttons = [];
  if (m.kind === "topic" && m.typed) buttons.push(el("button", { onclick: () => send({ type: "publish" }) }, "Publish"));
  if (m.kind === "variable" && m.writable) {
    buttons.push(el("button", { onclick: () => send({ type: "set", force: false }) }, "Set"));
    if (m.forceable) {
      buttons.push(el("button", { onclick: () => send({ type: "set", force: true }) }, "Force"));
      buttons.push(el("button", { onclick: () => vscode.postMessage({ type: "unforce" }) }, "Release"));
    }
  }
  if (m.kind === "function" || m.kind === "task") buttons.push(el("button", { onclick: () => send({ type: "call" }) }, "Call"));
  if (m.kind === "task" && m.cancellable) {
    cancel = el("button", { onclick: () => vscode.postMessage({ type: "cancel" }), disabled: "" }, "Cancel");
    buttons.push(cancel);
  }
  if (buttons.length) {
    const title = m.kind === "function" || m.kind === "task" ? "Request" : m.kind === "topic" ? "Publish" : "Write";
    parts.push(section(title, input, el("div", { class: "buttons" }, ...buttons)));
  }
  if (m.kind === "task") parts.push(section("Progress", progress));
  if (m.kind === "function" || m.kind === "task") parts.push(section("Result", resultHead, result));
  document.body.replaceChildren(...parts);
}

window.addEventListener("message", (e) => {
  const m = e.data;
  switch (m.type) {
    case "init":
      init(m);
      break;
    case "status":
      status.textContent = m.text;
      break;
    case "value":
      valueInfo.textContent = m.info;
      value.textContent = m.text;
      break;
    case "progress":
      progress.textContent = m.text;
      break;
    case "running":
      if (cancel) cancel.disabled = !m.on;
      if (m.on) progress.textContent = "";
      break;
    case "result":
      resultHead.textContent = m.head;
      resultHead.className = m.ok ? "info" : "info error";
      result.textContent = m.text;
      break;
  }
});

vscode.postMessage({ type: "ready" });
