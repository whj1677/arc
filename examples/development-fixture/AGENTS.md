# Order example rules

Keep money calculations deterministic. Use the existing Node.js test runner;
no package installation is needed. Preserve unrelated working tree changes.
Do not commit or push from an acceptance task. User-authored rule: keep the public
exports in src/index.mjs usable after a change.
