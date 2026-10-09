#!/usr/bin/env node
import { doctor } from "./doctor.js";

async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "doctor") {
    process.stdout.write(`${JSON.stringify(doctor(), null, 2)}\n`);
    return 0;
  }
  process.stderr.write("Usage: opencode-agents doctor\n");
  return 2;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
