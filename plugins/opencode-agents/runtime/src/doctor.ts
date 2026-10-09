import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { configurationPath, loadConfiguration, stateDirectory } from "./config.js";
import { compatibilityPath } from "./resources.js";

type DoctorResult = {
  runtime: { node: string; supportedNode: boolean; toolkit: string };
  configuration: { path: string; status: "missing" | "invalid" | "valid"; message?: string };
  backend: { binary: string | null; version: string | null; configuredModels: string[]; certifiedPairs: string[]; executionTested: boolean };
  storage: { path: string; exists: boolean };
};

export function doctor(): DoctorResult {
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  const result: DoctorResult = {
    runtime: { node: process.versions.node, supportedNode: major === 24 && minor >= 15, toolkit: "2.0.0-dev.0" },
    configuration: { path: configurationPath(), status: "missing" },
    backend: { binary: null, version: null, configuredModels: [], certifiedPairs: [], executionTested: false },
    storage: { path: stateDirectory(), exists: existsSync(stateDirectory()) },
  };
  const manifest = JSON.parse(readFileSync(compatibilityPath(), "utf8")) as {
    pairs: Array<{ binary_version: string; sdk_version: string; execution_supported: boolean }>;
  };
  result.backend.certifiedPairs = manifest.pairs.filter((pair) => pair.execution_supported)
    .map((pair) => `${pair.binary_version}/${pair.sdk_version}`);
  if (!existsSync(result.configuration.path)) return result;
  try {
    const config = loadConfiguration(result.configuration.path);
    result.configuration.status = "valid";
    result.backend.binary = config.opencode_binary;
    result.backend.configuredModels = Object.keys(config.models);
    const command = spawnSync(config.opencode_binary, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (command.status === 0) result.backend.version = command.stdout.trim();
    result.backend.executionTested = Boolean(result.backend.version && manifest.pairs.some(
      (pair) => pair.binary_version === result.backend.version && pair.execution_supported,
    ));
  } catch (error) {
    result.configuration.status = "invalid";
    result.configuration.message = String(error);
  }
  return result;
}
