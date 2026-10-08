/* Generated from contracts/aw-real-data-1.lock.json. Do not invent successor versions. */

export const AW_REAL_DATA_CONTRACT = {
  "schemaVersion": "aw-real-data/1",
  "algorithm": "sha256",
  "imported": true,
  "releaseEnabled": false,
  "runtimeEnforced": false,
  "source": {
    "repository": "https://github.com/augmentworks-org/augmentworks.git",
    "commit": "b198906188bab2dac9ae2a1ad539405807e46e1e",
    "schema": "docs/contracts/aw-real-data-1.schema.json",
    "fixtures": "docs/contracts/aw-real-data-1.fixtures.json",
    "checksums": "docs/contracts/aw-real-data-1.checksums.json",
    "spec": "docs/contracts/aw-real-data-1.md"
  },
  "expected": {
    "schema": "6a53d04f297eb4db275bb7074bf7705a08137d932be823a3f4087d84cfdf7121",
    "fixtures": "26033843d55dcb9b49ccf68fa96f7de9ec34aa6c299e8ab28b605cad37572230"
  },
  "files": {
    "contracts/aw-real-data-1.schema.json": "6a53d04f297eb4db275bb7074bf7705a08137d932be823a3f4087d84cfdf7121",
    "contracts/aw-real-data-1.fixtures.json": "26033843d55dcb9b49ccf68fa96f7de9ec34aa6c299e8ab28b605cad37572230"
  },
  "contract": {
    "revision": 1,
    "executionScope": "aw-execution-scope/1",
    "localExecutionScope": "aw-local-execution-scope/1",
    "authorizedPacket": "aw-packet/authorized-1",
    "localAuthorizedPacket": "aw-packet/local-authorized-1",
    "suiteSchema": "aw-suite/3",
    "nativeSuite": "aw-customer-suite/3",
    "reportScope": "authorized-1",
    "capabilitiesPath": "/v1/capabilities",
    "executionScopePath": "/v1/execution-scopes/{scopeId}",
    "privacyInterface": {
      "applyRedactionProfile": "applyRedactionProfile(input, profile, policy, secrets)",
      "sealDataHandlingReceipt": "sealDataHandlingReceipt(result, policy, profile, processor)"
    }
  }
} as const;

export type AwRealDataContract = typeof AW_REAL_DATA_CONTRACT;
