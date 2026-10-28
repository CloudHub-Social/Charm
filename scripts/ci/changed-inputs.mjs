import { execFileSync } from "node:child_process";

const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value);
const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe" });

// A PR event's base SHA can lag behind checkout's synthetic merge. Read the
// actual commit object (not rev-list, which hides parents at shallow boundaries).
export function changedInputs({ eventName, event, revision }, run = git) {
  let base = null;
  let parents = null;
  try {
    if (!sha(revision)) throw new Error("invalid revision");
    if (run(["rev-parse", "HEAD"]).trim() !== revision) throw new Error("checkout mismatch");
    if (eventName === "pull_request") {
      if (!sha(event.pull_request?.head?.sha)) throw new Error("missing PR head");
      run(["fetch", "--no-tags", "--depth=2", "--quiet", "origin", revision]);
      const header = run(["cat-file", "-p", revision]).split("\n\n", 1)[0];
      parents = header
        .split("\n")
        .filter((line) => line.startsWith("parent "))
        .map((line) => line.slice(7));
      if (
        parents.length !== 2 ||
        !parents.every(sha) ||
        parents[0] === parents[1] ||
        parents[1] !== event.pull_request.head.sha
      )
        throw new Error("PR merge parents mismatch");
      base = parents[0];
    } else {
      base =
        eventName === "push"
          ? event.before
          : eventName === "merge_group"
            ? event.merge_group?.base_sha
            : null;
      if (!sha(base)) throw new Error("no diff base");
      run(["fetch", "--no-tags", "--depth=1", "--quiet", "origin", base]);
    }
    const diff = run(["diff", "--no-renames", "--name-only", "-z", base, revision]);
    if (diff && !diff.endsWith("\0")) throw new Error("incomplete diff");
    const paths = diff ? diff.slice(0, -1).split("\0") : [];
    if (
      paths.some(
        (path) =>
          !path || /[\r\n]/.test(path) || path.startsWith("/") || path.split("/").includes(".."),
      )
    ) {
      throw new Error("invalid changed path");
    }
    return { base, parents, paths, fallback: false };
  } catch {
    // Never replace a failed/mismatched merge with the stale event base.
    return { base, parents, paths: null, fallback: true };
  }
}
