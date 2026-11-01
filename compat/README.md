# Compatibility baselines and fixtures

This directory is the contract described in [docs/COMPATIBILITY.md](../docs/COMPATIBILITY.md).

- `baseline/<ref>/` — recorded from an upstream build with `npm run compat:baseline -- <ref>`.
  `tools-list.json` is the `tools/list` result, `outputs.json` is the JSON shape of every
  scenario step's output. Never edit by hand and never re-record from the code under test.
- `fixtures/upstream-v0.2.1/` — configuration files a v0.2.1 user may have today. They must
  keep loading unchanged, forever.
