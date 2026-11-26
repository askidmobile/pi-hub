#!/usr/bin/env bash
# Turn-end hook: if the hub has pending worker questions for this session, print
# {"decision":"block","reason":"<question>"}; otherwise print nothing.
# Budget: < 100 ms; checks mode first; any error -> exit 0 (never blocks the senior).
exec pi-hub hook stop --client claude-code 2>/dev/null || exit 0
