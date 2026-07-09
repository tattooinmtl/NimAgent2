// test-classify.mjs — live routing smoke test.
// Tests the full classify stack: JS heuristics + ML model via the sidecar.
// Run with:  node test-classify.mjs

import { classifyIntent, killSidecar, PERSONAS } from "../src/integrations/router.mjs";

const settings = {
  router: {
    enabled: true,
    python: { interpreter: "python", confidenceThreshold: 0.55, timeoutMs: 3000 },
  },
};

const TURNS = [
  // coding
  "fix the null pointer exception in server.js",
  "refactor the database connection pool",
  "write a pytest test for the login endpoint",
  "the CI pipeline fails on the docker build step",
  "add rate limiting middleware to the Express app",
  // assistant
  "what is the difference between TCP and UDP",
  "explain how a JWT token works",
  "summarize what microservices are",
  "what are some good practices for API design",
  "write me a poem about late-night debugging sessions",
  // ambiguous — should still return a valid persona
  "help me think through this",
  "what should I do next",
  "can you look at this",
];

console.log("\nRouting smoke test — full stack (JS heuristics + ML sidecar)\n");

let passed = 0;
const EXPECTED = [
  "coding","coding","coding","coding","coding",
  "assistant","assistant","assistant","assistant","assistant",
  null, null, null, // ambiguous — any valid persona is fine
];

for (let i = 0; i < TURNS.length; i++) {
  const msg = TURNS[i];
  const expected = EXPECTED[i];
  const persona = await classifyIntent({ message: msg, settings });
  const ok = !expected || persona.id === expected;
  const tag = ok ? "✓" : "✗";
  const label = persona.id.padEnd(9);
  console.log(`  ${tag} [${label}]  ${msg}`);
  if (ok) passed++;
}

console.log(`\n  ${passed}/${TURNS.length} correct\n`);
killSidecar();
