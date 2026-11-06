# Provider fixtures

The Rust tests use sanitized Claude Code cache and CLI responses and Codex
rate-limit responses. The fake Codex App Server in `bin/` exercises stdio
request ordering, error handling, and timeouts without starting model turns.
