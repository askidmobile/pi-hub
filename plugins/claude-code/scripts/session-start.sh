#!/usr/bin/env bash
# Registers the Claude Code session_id with the hub (MCP does not carry it).
# Must never block: any failure -> exit 0 silently.
exec pi-hub hook session-start --client claude-code 2>/dev/null || exit 0
