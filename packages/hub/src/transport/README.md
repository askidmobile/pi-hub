# transport

- `unix-socket.ts` — local transport, socket file mode 0600.
- `http.ts` — Streamable HTTP MCP with bearer token; binds 127.0.0.1 only, remote access via SSH tunnel / VPN.
- Handshake: `Hello` / `HelloAck` / `HelloReject` from `@pi-hub/protocol`.
