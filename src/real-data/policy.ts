import type { RelayCommand } from "../cloud/protocol.js";
import type { ResolvedConfig } from "../config/types.js";
import type { RelayJournal } from "../relay/journal.js";
import {
  assertLiveCommandAllowed,
  liveExecutionPolicyFromSuite,
  type LiveExecutionPolicy
} from "../suite/live-policy.js";
import { isLiveCustomerSuite, type CustomerSuite } from "../suite/schema.js";
import {
  assertBoundaryMatchesConfig,
  assertCommandWithinBoundary,
  assertScopeNotExpired,
  assessedIdentityOrigin,
  operationPermittedByEffects
} from "./boundary.js";
import { assertCommandWithinBudget, journalBudgetConsumption } from "./budget.js";
import type {
  DataPolicy,
  ExecutionScope,
  LocalExecutionScope,
  RedactionProfile,
  TargetBoundary
} from "./documents.js";
import { realDataError } from "./errors.js";

export type AuthorizedDispatchPolicy = {
  readonly kind: "authorized";
  /** Local scopes are customer-declared and may assess a private origin. */
  readonly local: boolean;
  readonly origin: string;
  readonly expiresAt: string;
  readonly budget: LocalExecutionScope["budget"] | ExecutionScope["budget"];
  readonly boundary: TargetBoundary;
  readonly effects: ExecutionScope["effects"];
  readonly cleanupPermitted: boolean;
  readonly sendReplayable: false;
  readonly dataPolicy?: DataPolicy;
  readonly redactionProfile?: RedactionProfile;
};

export type DispatchPolicy =
  | { readonly kind: "live_informational"; readonly live: LiveExecutionPolicy }
  | AuthorizedDispatchPolicy;

export function liveDispatchPolicyFromSuite(
  suite: CustomerSuite,
  now = Date.now()
): DispatchPolicy | undefined {
  if (!isLiveCustomerSuite(suite)) return undefined;
  const live = liveExecutionPolicyFromSuite(suite, now);
  return live === undefined ? undefined : { kind: "live_informational", live };
}

export function authorizedDispatchPolicy(options: {
  readonly scope: ExecutionScope | LocalExecutionScope;
  readonly boundary: TargetBoundary;
  readonly now?: number;
  readonly dataPolicy?: DataPolicy;
  readonly redactionProfile?: RedactionProfile;
}): AuthorizedDispatchPolicy {
  assertScopeNotExpired(options.scope.expiresAt, options.now ?? Date.now());
  const local = options.scope.schemaVersion === "aw-local-execution-scope/1";
  return {
    kind: "authorized",
    local,
    origin: assessedIdentityOrigin(options.boundary, { allowPrivate: local }),
    expiresAt: options.scope.expiresAt,
    budget: options.scope.budget,
    boundary: options.boundary,
    effects: options.scope.effects,
    cleanupPermitted: operationPermittedByEffects("cleanup", options.scope.effects),
    sendReplayable: false,
    ...(options.dataPolicy === undefined ? {} : { dataPolicy: options.dataPolicy }),
    ...(options.redactionProfile === undefined ? {} : { redactionProfile: options.redactionProfile })
  };
}

export function assertDispatchReadyForQuote(
  policy: DispatchPolicy | undefined,
  resolved: ResolvedConfig
): void {
  if (policy === undefined) return;
  if (policy.kind === "live_informational") {
    return;
  }
  assertBoundaryMatchesConfig(policy.boundary, resolved, {
    allowPrivate: policy.local,
    effects: policy.effects
  });
}

export function assertCommandAllowed(
  command: RelayCommand,
  policy: DispatchPolicy,
  journal: RelayJournal,
  now = Date.now()
): void {
  if (policy.kind === "live_informational") {
    assertLiveCommandAllowed(command, policy.live, journal, now);
    return;
  }
  assertScopeNotExpired(policy.expiresAt, now);
  assertCommandWithinBoundary(command, policy.effects);
  if (command.kind === "cleanup" && !policy.cleanupPermitted) {
    throw realDataError(
      "ACTION_NOT_ALLOWED",
      "Cleanup is not permitted unless the admitted scope explicitly allows that action."
    );
  }
  if (policy.effects === "informational" && command.kind !== "send" && command.kind !== "observe") {
    if (command.kind === "prepare" || command.kind === "cleanup") {
      throw realDataError(
        "ACTION_NOT_ALLOWED",
        `Informational authorized assessments do not permit ${command.kind} unless the admitted boundary lists it.`
      );
    }
  }
  const existing = journal.state(command.command_id);
  assertCommandWithinBudget(command, policy.budget, journalBudgetConsumption(journal), existing?.started === true);
}

export function sendIsReplayable(policy: DispatchPolicy | undefined): boolean {
  if (policy === undefined) return true;
  if (policy.kind === "live_informational") return false;
  return policy.sendReplayable;
}
