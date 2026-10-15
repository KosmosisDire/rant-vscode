const BARE = /^[\w@%+=:,./\\-]+$/;
const WINDOWS_SHELL = /pwsh|powershell|cmd/i;
const POWERSHELL = /pwsh|powershell/i;

function quote(s: string, shell: string): string {
  if (BARE.test(s)) return s;
  // a Windows shell keeps backslashes as they are, a posix shell needs them escaped
  return WINDOWS_SHELL.test(shell) ? `"${s}"` : `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** One terminal line that runs the CLI, quoted for the shell the terminal uses. */
export function shellLine(display: string, args: string[], shell: string): string {
  const exe = quote(display, shell);
  const call = exe !== display && POWERSHELL.test(shell) ? `& ${exe}` : exe;
  return [call, ...args.map((a) => quote(a, shell))].join(" ");
}
