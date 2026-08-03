/**
 * Container-side logging.
 *
 * Every module used to define its own `log(msg)` that console.error'd a tagged
 * line with no timestamp. That made container logs readable for *order* but
 * not for *when* — you could see a turn had stalled but not for how long, and
 * could not line an event up against anything in the host log. `podman logs`
 * can add a timestamp with --timestamps, but only if you remember the flag,
 * and it is lost the moment the output is pasted anywhere else.
 *
 * The format deliberately matches src/log.ts on the host so the two can be
 * read side by side, and carries the date: containers outlive a day, and
 * "03:14:02" alone is ambiguous in a log that spans several.
 */

export function ts(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/** Build a tagged logger: `logger('poll-loop')` → `[ts] [poll-loop] msg`. */
export function logger(tag: string): (msg: string) => void {
  return (msg: string): void => {
    console.error(`[${ts()}] [${tag}] ${msg}`);
  };
}
