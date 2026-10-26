import { pathToFileURL } from "node:url";
export function assertResults(needs) {
  if (needs.changes?.result !== "success") throw new Error("Change detection must succeed");
  const selection = needs.changes.outputs;
  const lanes = {
    rust: "platform",
    "rust-integration": "integration",
    "rust-integration-qr": "integration",
    "companion-container": "companion_container",
  };
  if (needs["rust-audit"]?.result !== "success") throw new Error("Rust audit must succeed");
  for (const [job, key] of Object.entries(lanes)) {
    if (!["true", "false"].includes(selection?.[key])) throw new Error(`Missing selection: ${key}`);
    const result = needs[job]?.result;
    if (
      selection[key] === "true" ? result !== "success" : !["success", "skipped"].includes(result)
    ) {
      throw new Error(`Invalid ${job} result: ${result}; selected=${selection[key]}`);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  assertResults(JSON.parse(process.env.CI_NEEDS));
