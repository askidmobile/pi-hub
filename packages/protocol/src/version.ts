/**
 * Protocol version for shim <-> hub handshake.
 * Bump MAJOR on breaking wire changes; the hub rejects a shim with another MAJOR
 * and replies with an explicit "update plugin" / "update hub" error.
 */
export const PROTOCOL_VERSION = "0.2.0"; // 0.2: hook_query (additive, plan PD-108)

export function isCompatible(a: string, b: string): boolean {
  return a.split(".")[0] === b.split(".")[0];
}
