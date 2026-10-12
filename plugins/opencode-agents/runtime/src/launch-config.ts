import { createHash } from "node:crypto";

/** Private execution contract. It is never included in MCP task projections. */
export type ManagedLaunchContract = {
  configContent: string;
  effectiveConfigSha256: string;
  reportPath: string;
};

export type SelectedModel = { provider_id: string; model_id: string; destination: string };

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

export function effectiveConfigHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Compare launches while allowing only the assigned report directory to change. */
export function policyNeutralConfigHash(contract: ManagedLaunchContract): string {
  const config = JSON.parse(contract.configContent) as Record<string, unknown>;
  const agents = { ...(config.agent as Record<string, unknown> | undefined) };
  delete agents["bounded-inspect"];
  delete agents["bounded-build"];
  return effectiveConfigHash({ ...config, agent: agents });
}

export function assertFrozenEffectiveConfig(value: unknown, contract: ManagedLaunchContract): void {
  if (effectiveConfigHash(value) !== contract.effectiveConfigSha256)
    throw new Error("OpenCode effective configuration changed since task admission");
}

/** Bind the operator's destination declaration to the frozen provider route. */
export function assertSelectedModelDestination(model: SelectedModel, contract: ManagedLaunchContract): void {
  const config = JSON.parse(contract.configContent) as Record<string, unknown>;
  const providers = config.provider as Record<string, unknown> | undefined;
  const provider = providers?.[model.provider_id] as Record<string, unknown> | undefined;
  const options = provider?.options as Record<string, unknown> | undefined;
  const baseURL = options?.baseURL ?? options?.baseUrl ?? provider?.baseURL;
  if (typeof baseURL !== "string") throw new Error(`provider ${model.provider_id} has no frozen destination URL`);
  let actual: URL;
  try { actual = new URL(baseURL); }
  catch { throw new Error(`provider ${model.provider_id} has an invalid destination URL`); }
  if (model.destination === "local") {
    if (actual.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(actual.hostname))
      throw new Error(`provider ${model.provider_id} is not routed to the declared local destination`);
  } else {
    let declared: URL;
    try { declared = new URL(model.destination); }
    catch { throw new Error("model destination must be 'local' or an exact URL"); }
    if (actual.href.replace(/\/$/, "") !== declared.href.replace(/\/$/, ""))
      throw new Error(`provider ${model.provider_id} route differs from the declared destination`);
  }
  const models = provider?.models;
  if (models && typeof models === "object" && !Array.isArray(models) &&
    !Object.hasOwn(models, model.model_id))
    throw new Error(`model ${model.provider_id}/${model.model_id} is absent from frozen provider configuration`);
}
