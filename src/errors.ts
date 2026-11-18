export class CliError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly detail?: unknown;
  constructor(code: string, message: string, opts: { status?: number; detail?: unknown } = {}) {
    super(message);
    this.code = code;
    this.status = opts.status;
    this.detail = opts.detail;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.now();
/** Stage trace on stderr when X_CLI_DEBUG is set (never prints cookie values). */
export function debug(msg: string): void {
  if (process.env.X_CLI_DEBUG) process.stderr.write(`[x-cli +${Date.now() - T0}ms] ${msg}\n`);
}
