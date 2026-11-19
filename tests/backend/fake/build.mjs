// Builds tests/backend/fake/backend.js: the real server.js with its AGENTS namespace swapped for the
// deterministic FAKE agents (fake/agents.js, with test hooks like [slow], [fail-work]). Used by
// pipeline.test.mjs and race.test.mjs to exercise backend state-machine edge cases. Run automatically by lib.mjs.
import fs from "node:fs";
const src = fs.readFileSync(new URL("../../../server.js", import.meta.url), "utf8");
const a = src.indexOf("const AGENTS = (() => {");
const end = "\n})();\n";
const b = src.indexOf(end, a);
if (a < 0 || b < 0) throw new Error("AGENTS IIFE not found in server.js");
const out = src.slice(0, a) + 'import * as AGENTS from "./agents.js";' + src.slice(b + end.length - 1);
fs.writeFileSync(new URL("./backend.js", import.meta.url), out);
