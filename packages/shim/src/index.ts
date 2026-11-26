#!/usr/bin/env node
/**
 * pi-hub-shim: one tiny process per senior session.
 * stdio MCP <-> hub (unix socket locally, HTTP via tunnel remotely). No logic, no keys.
 * Sends Hello { client, client_session_id?, parent_pid: process.ppid, project } on connect.
 * Remote: `ssh build-box pi-hub-shim`.
 */
console.error("pi-hub-shim: not implemented yet (stage 1)");
process.exitCode = 1;
