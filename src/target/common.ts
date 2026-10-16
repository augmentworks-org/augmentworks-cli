import { AwError } from "../errors.js";
import type { ResolvedConfig } from "../config/types.js";
import { runDoctor, type DoctorReport } from "../commands/doctor.js";

export type TargetDoctor = (options: Parameters<typeof runDoctor>[0]) => Promise<DoctorReport>;

export async function loadTargetConfig(
  config: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  doctor: TargetDoctor | undefined
): Promise<ResolvedConfig> {
  const report = await (doctor ?? runDoctor)({ config, cwd, processEnv: env, offline: true });
  if (!report.ok || report.resolvedConfig === undefined) {
    const error = report.diagnostics.find((diagnostic) => diagnostic.level === "error");
    throw new AwError({
      code: error?.code ?? "DOCTOR_FAILED",
      category: "config",
      message: error?.message ?? "augmentworks.yaml has errors. Run `augmentworks doctor --offline` to see them."
    });
  }
  return report.resolvedConfig;
}

export function ownerLoginRequiredError(action = "Registering a target"): AwError {
  return new AwError({
    code: "TARGET_OWNER_LOGIN_REQUIRED",
    category: "auth",
    message: `${action} needs a workspace owner's login, and machine keys can't do it. Unset AUGMENTWORKS_API_KEY and run \`augmentworks login\` as an owner.`
  });
}

/** Quotes a target name for the next-step command line only when it needs it. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9._@%+=:,/-]+$/u.test(value) ? value : `'${value.replace(/'/gu, "'\\''")}'`;
}

