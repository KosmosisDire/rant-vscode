# Rant for VS Code

Support for Rant workspaces: highlighting and completion for the config files, errors in the
Problems panel, and a sidebar to build, start and stop nodes. It drives the `rant` command
line tool and needs it installed.

## Install

```
rant vscode install          # the newest release, through VS Code's `code` command
rant vscode install --editor cursor
rant vscode uninstall
```

`rant update` keeps it current. Run it in a remote terminal (SSH, WSL) to install the
extension on that remote, where it runs.

## Features

### Config files

- Language `rant` for `workspace.rant`, `package.rant`, `*.rant` and `*.run` (groups). They
  are HCL, so there is highlighting for comments, blocks, attributes, strings with `${...}`,
  heredocs, numbers and operators, plus brackets, folding and indentation.
- Completion of the blocks and keys each file kind takes, with a short doc for each. Inside
  a `param`, `include` or `node` block it offers that block's keys. After `type =` it offers
  the param types, and in an expression it offers `path.*` and the group's `param.*` names.
- Errors from the CLI on the file and line it names, on open, on save and when a config file
  changes. A workspace is checked with `rant ls packages` and a dry run of each group.

### Workspaces view

The Rant icon in the activity bar opens the Workspaces view.

- Every `workspace.rant` under the open folders, found by walking them, skipping `.git`,
  `.rant`, `node_modules`, `_deps`, `build`, `bin`, `dist`, `target`, `out`, virtualenvs and
  CMake build trees. A folder with three workspaces shows three. Files that appear or
  disappear are picked up.
- Under each workspace: its packages, its nodes (all that could start, the running ones
  first) and its groups, read with `rant ls ... --json`.
- Inline buttons and the context menu:
  - Build: a workspace or a package (`rant build [package]`).
  - Start: a node (`rant run node X`) or a group (`rant run G`).
  - Stop and Restart: a node, a group or a whole workspace.
  - Open Source: a node's file, or its `node` block in `package.rant`.
  - New From Preset: `rant new` for a workspace, package, node or group, with a name and a
    language where it applies.
  - Refresh, in the view title.
- Commands that run for a while go to a terminal named `Rant: <workspace folder>`, started
  in the workspace folder. Reads run in the background and never block the editor.
- The view refreshes when `*.rant`, `*.run` or `.rant/state` change, and checks what runs
  every 3 seconds while it is visible.

### Mesh view

The Mesh view under Workspaces shows the running mesh through the Rant bridge, the local
service that `rant bridge enable` sets up. The extension reads the bridge's URL and
passphrase from `~/.rant/bridge.yaml` and `~/.rant/bridge.state`, so there is nothing to
configure.

- Nodes, with their round trip as the editor sees it. Open a node for what it offers.
- Topics, variables, functions and tasks, with their type and how many ends each has. The
  view reads the mesh again whenever it changes.
- Click an entity to open its page:
  - A topic shows its newest value and rate, at most 30 per second, and can publish one.
  - A variable shows its value and can set, force and release it.
  - A function takes a request and shows the result. A task also shows its progress and
    can be cancelled.
  - Values are edited as JSON, starting from a template of the type.
- The view title changes the domain and shows the other nodes' log lines.
- The status bar shows whether the editor is connected and on which domain. When the
  bridge is missing or stopped, the view offers to enable or start it.

Video and images show as their size only for now.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `rant.cliPath` | empty | Path of the `rant` tool. Empty uses `rant` on PATH, then `~/.rant/bin/rant`. |
| `rant.domain` | empty | The domain the Mesh view explores. Empty uses `RANT_DOMAIN`, else 0. |

The extension runs where the folder is, so it works over SSH, WSL and containers, as long
as `rant` is installed there, and the bridge for the Mesh view. Nodes start on the
workspace's domain, else `RANT_DOMAIN`.

## Build and test

```
npm install        # needs the client built in ../web-rant/client
npm run build      # dist/extension.js with esbuild
npm run watch
npm run check      # tsc --noEmit
npm test           # node:test, needs Node 22.7 or newer
npm run package    # a .vsix with vsce
```

`rantBridge` in `package.json` names the bridge release whose client CI builds against.
A tag `v<version>` cuts a release with `rant-vscode-<version>.vsix`.

Press F5 in VS Code on this folder to try it in an Extension Development Host. The tests
read their CLI output from `test/fixtures/cli`, and the completion tests also compare the
keys with the Rust crate in `../cli-rant/config/src` when it is there.

## Layout

```
src/cli/          finding and running the CLI, reading its JSON and errors
src/bridge/       the connection to the bridge, its settings and the status bar item
src/workspaces/   finding workspaces, watching their files, loading what the view shows
src/views/        one folder per view: workspaces/ and mesh/, each with its tree and commands
src/language/     the completion vocabulary and provider, the diagnostics
```

A new view gets its own folder under `src/views/` and a line in `extension.ts`.
