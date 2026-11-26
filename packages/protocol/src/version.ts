/**
 * Protocol version for shim <-> hub handshake.
 * Bump MAJOR on breaking wire changes; the hub rejects a shim with another MAJOR
 * and replies with an explicit "update plugin" / "update hub" error.
 */
export const PROTOCOL_VERSION = "0.1.0";

export function isCompatible(a: string, b: string): boolean {
  return a.split(".")[0] === b.split(".")[0];
}
