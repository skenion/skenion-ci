#!/usr/bin/env node

console.error(
  "::error title=Release Please dispatch removed::" +
    "skenion-ci no longer dispatches component Release Please workflows from main. " +
    "Component repositories own their Release Please flows; use the compatibility matrix verifier for promotion evidence.",
);
process.exit(1);
