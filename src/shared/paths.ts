/**
 * Path presentation helpers shared by the main process and the renderer.
 *
 * The renderer only ever receives display paths from `fs.complete` and
 * `fs.relativize`; quoting is applied identically on both sides so composer
 * insertions match what the main process would have produced.
 */

/** Quote a dropped or completed path for insertion into the composer. */
export function quotePath(path: string): string {
  return /[\s"']/.test(path) ? `"${path.replaceAll('"', '\\"')}"` : path;
}
