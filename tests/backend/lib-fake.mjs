// Same helpers as lib.mjs, but the server under test is server.js with the deterministic FAKE agents.
import "./fake/build.mjs";
import "./fake/env.mjs";
export * from "./lib.mjs";
