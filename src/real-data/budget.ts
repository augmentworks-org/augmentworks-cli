import type { RelayCommand } from "../cloud/protocol.js";
import type { RelayJournal } from "../relay/journal.js";
import type { ExecutionBudget } from "./documents.js";
import { realDataError } from "./errors.js";

export type BudgetConsumption = {
  readonly messages: number;
  readonly commands: number;
  readonly actions: number;
};

export function journalBudgetConsumption(journal: RelayJournal): BudgetConsumption {
  const extra =
    typeof (journal as RelayJournal & { dispatchedCommandCount?: () => number }).dispatchedCommandCount ===
    "function"
      ? {
          commands: journal.dispatchedCommandCount(),
          actions: journal.dispatchedActionCount()
        }
      : countFromJournal(journal);
  return {
    messages: journal.dispatchedSendCount(),
    commands: extra.commands,
    actions: extra.actions
  };
}

function countFromJournal(journal: RelayJournal): { commands: number; actions: number } {
  let commands = 0;
  let actions = 0;
  for (const commandId of journalCommandIds(journal)) {
    const state = journal.state(commandId);
    if (state?.started !== true) continue;
    commands += 1;
    if (state.accepted.kind !== "send") actions += 1;
  }
  return { commands, actions };
}

function journalCommandIds(journal: RelayJournal): string[] {
  const maybe = journal as RelayJournal & { commandIds?: () => string[] };
  if (typeof maybe.commandIds === "function") return maybe.commandIds();
  return [];
}

export function assertCommandWithinBudget(
  command: RelayCommand,
  budget: ExecutionBudget,
  consumption: BudgetConsumption,
  alreadyStarted: boolean
): void {
  if (alreadyStarted) return;
  const nextCommands = consumption.commands + 1;
  const nextMessages = consumption.messages + (command.kind === "send" ? 1 : 0);
  const nextActions = consumption.actions + (command.kind === "send" ? 0 : 1);
  if (nextCommands > budget.maxCommands || nextMessages > budget.maxMessages || nextActions > budget.maxActions) {
    throw realDataError(
      "EXECUTION_BUDGET_EXHAUSTED",
      `This run used up its scope's allowance of ${String(budget.maxMessages)} messages, ${String(budget.maxActions)} actions and ${String(budget.maxCommands)} commands, counting sends whose outcome is unknown.`
    );
  }
}

export function consumeProbeAllowance(budget: ExecutionBudget, consumption: BudgetConsumption): BudgetConsumption {
  const next: BudgetConsumption = {
    messages: consumption.messages + 1,
    commands: consumption.commands + 1,
    actions: consumption.actions
  };
  if (next.messages > budget.maxMessages || next.commands > budget.maxCommands) {
    throw realDataError(
      "EXECUTION_BUDGET_EXHAUSTED",
      "A connection check sends a real message to your agent, and this run's scope has no allowance left for it."
    );
  }
  return next;
}

export function effectiveBudget(budget: ExecutionBudget, creditCeiling?: number): ExecutionBudget {
  return {
    ...budget,
    maxCredits:
      creditCeiling === undefined ? budget.maxCredits : Math.min(budget.maxCredits, Math.max(0, creditCeiling))
  };
}
