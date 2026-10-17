import { readFileSync } from "node:fs";

const fixtures = JSON.parse(
  readFileSync(new URL("../../contracts/aw-run-report-v1.fixtures.json", import.meta.url), "utf8")
) as { fixtures: Record<string, { response: Record<string, unknown> }> };

/** The path `test` and `run wait` read the graded outcome from. */
export function reportPathFor(runId: string): string {
  return `/v1/relay/runs/${encodeURIComponent(runId)}/report`;
}

/**
 * A graded `aw-run-report/1` first page for a stub server, from the contract's
 * all-pass or required-fail fixture.
 */
export function gradedReport(
  runId: string,
  workspaceId: string,
  options: { readonly outcome?: "passed" | "failed"; readonly reportReady?: boolean; readonly evaluationStatus?: string } = {}
): Record<string, unknown> {
  const name = options.outcome === "failed" ? "report_required_fail" : "report_all_pass_one_page";
  const base = structuredClone(fixtures.fixtures[name]?.response);
  if (base === undefined) throw new Error(`missing report fixture ${name}`);
  return {
    ...base,
    runId,
    workspaceId,
    ...(options.reportReady === undefined ? {} : { reportReady: options.reportReady }),
    ...(options.evaluationStatus === undefined ? {} : { evaluationStatus: options.evaluationStatus })
  };
}
