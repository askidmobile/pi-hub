/** Errors the facade maps to short tool answers for the senior agent. */
export type HubErrorCode =
  | "delegation_off"
  | "repo_not_allowed"
  | "not_a_repo"
  | "base_not_found"
  | "not_found"
  | "bad_state"
  | "model"
  | "missing_key";

export class HubError extends Error {
  constructor(
    public readonly code: HubErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HubError";
  }
}
