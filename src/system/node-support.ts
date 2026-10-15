/** Must match `engines.node` in package.json. */
export const SUPPORTED_NODE_MINIMUM = { major: 22, minor: 12 } as const;

/**
 * A one-line stderr warning for Node.js releases below `engines.node`, or null.
 * The CLI still runs: older releases work today, they are just unsupported.
 */
export function nodeSupportWarning(version: string): string | null {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  if (match == null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const { major: minMajor, minor: minMinor } = SUPPORTED_NODE_MINIMUM;
  if (major > minMajor || (major === minMajor && minor >= minMinor)) return null;
  return (
    `Warning: AugmentWorks supports Node.js ${minMajor}.${minMinor} or newer. ` +
    `You're running v${version.replace(/^v/, "")}. ` +
    "Upgrade to the current LTS release: https://nodejs.org/en/download"
  );
}
