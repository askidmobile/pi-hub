import { git } from "./git.js";

/** Git root of `path` (resolves symlinks via git), or null outside a repository. */
export async function gitTopLevel(path: string): Promise<string | null> {
  try {
    return await git(path, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

export async function remoteUrl(repoRoot: string): Promise<string | null> {
  try {
    return (await git(repoRoot, ["remote", "get-url", "origin"])) || null;
  } catch {
    return null;
  }
}
