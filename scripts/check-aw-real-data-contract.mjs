import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertVendoredContract, fileExists, root } from "./aw-real-data-contract.mjs";

const RETRIEVAL_PATH = resolve(root, "contracts/aw-real-data-1.retrieval.json");

const result = await assertVendoredContract();
if (!(await fileExists(RETRIEVAL_PATH))) {
  throw new Error(
    "contracts/aw-real-data-1.retrieval.json is required. Record verified Linear/GitHub/local provenance; do not fabricate pinned files."
  );
}
const retrieval = JSON.parse(await readFile(RETRIEVAL_PATH, "utf8"));
if (
  retrieval.expected?.schema !== result.lock.expected.schema ||
  retrieval.expected?.fixtures !== result.lock.expected.fixtures
) {
  throw new Error("retrieval record expected hashes must match the frozen R01 lock");
}
if (retrieval.source?.commit !== result.lock.source.commit) {
  throw new Error("retrieval record source commit must match the frozen R01 lock");
}
if (result.imported === true) {
  if (retrieval.imported !== true || retrieval.verified !== true) {
    throw new Error("retrieval record must claim imported/verified when lock.imported is true");
  }
  const access = retrieval.source?.access;
  const githubAtLock = access?.kind === "github" && access.ref === result.lock.source.commit;
  if (access?.kind !== "linear_attachment" && !githubAtLock) {
    throw new Error("imported R01 receipt must record Linear attachment or GitHub provenance at the locked commit");
  }
} else {
  if (retrieval.imported === true || retrieval.verified === true) {
    throw new Error("retrieval record must not claim imported/verified when lock.imported is false");
  }
}

const imported = result.imported ? "imported" : "parsers-only (R01 bytes not vendored in this clone)";
process.stdout.write(
  `CLI real-data contract ok: aw-real-data/1 from ${result.lock.source.commit} ${imported} expected schema=${result.lock.expected.schema} fixtures=${result.lock.expected.fixtures} releaseEnabled=true\n`
);

