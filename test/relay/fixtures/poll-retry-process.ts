// AUG-412: runs a relay whose first poll returns a retryable 503, in its own
// process. Nothing but the retry pause is pending, so the pause timer must keep
// Node alive until the next poll.
import type { CloudClient } from "../../../src/cloud/client.js";
import type { CreateRunResponse } from "../../../src/cloud/protocol.js";
import { AwError } from "../../../src/errors.js";
import { RelayRunner } from "../../../src/relay/runner.js";
import { packet } from "../helpers.js";

const stateDirectory = process.argv[2];
if (stateDirectory === undefined) throw new Error("state directory required");

const binding: CreateRunResponse = {
  protocol_version: "aw-relay/0.1",
  create_request_id: `crq_${"a".repeat(24)}`,
  create_request_sha256: "c".repeat(64),
  create_disposition: "created",
  run_id: "run-1",
  session_id: "session-1",
  packet,
  config_sha256: "b".repeat(64),
  fencing_epoch: 2,
  status: "connected",
  dashboard_url: "https://augmentworks.ai/dashboard/runs/run-1",
  run_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  credit_state: "reserved"
};

let polls = 0;
const cloud = {
  async pollOperation() {
    polls += 1;
    if (polls === 1) {
      throw new AwError({
        code: "RELAY_UNAVAILABLE",
        category: "relay",
        message: "The relay is temporarily unavailable.",
        retryable: true,
        details: { http_status: 503, retry_after_ms: 200 }
      });
    }
    return {
      protocol_version: "aw-relay/0.1" as const,
      run_id: "run-1",
      session_id: "session-1",
      status: "completed",
      command: null
    };
  },
  async getRunStatus() {
    return {
      protocol_version: "aw-relay/0.1" as const,
      run_id: "run-1",
      status: "completed",
      outcome: "passed",
      credit_state: "consumed"
    };
  }
} as unknown as CloudClient;

const run = await new RelayRunner({
  cloud,
  connector: { execute: async () => { throw new Error("no commands expected"); } },
  binding,
  stateDirectory,
  pollWaitMs: 0,
  pollRetryBaseMs: 1
}).run();
process.stdout.write(`${JSON.stringify({ status: run.status, polls })}\n`);
