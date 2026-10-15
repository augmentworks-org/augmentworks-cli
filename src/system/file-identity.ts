/**
 * Whether two stat snapshots name the same file.
 *
 * Node.js 22.12.0–22.16.x (libuv 1.49.x) and 24.0.0–24.1.x (libuv 1.50.0)
 * declare `FILE_STAT_BASIC_INFORMATION` with `VolumeSerialNumber` and
 * `FileId128` swapped. On NTFS, path `stat`/`lstat` then reports `dev: 0`
 * while `fstat` reports the volume serial. libuv 1.51.0 fixed the layout
 * (https://github.com/libuv/libuv/commit/82cdfb75ff9bbd0dc65820ca418b7c5d412ff4d7).
 * `engines.node` is `>=22.12`, so those releases are supported. A zero `dev`
 * is unknown on Windows; the file index still has to match, and two nonzero
 * device ids still have to match.
 */
export function sameFileIdentity(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
  platform: NodeJS.Platform = process.platform
): boolean {
  if (left.ino !== right.ino) return false;
  if (left.dev === right.dev) return true;
  return platform === "win32" && (left.dev === 0 || right.dev === 0);
}
