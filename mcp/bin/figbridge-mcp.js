#!/usr/bin/env node
import { main } from "../src/server.js";
main().catch((e) => {
  process.stderr.write(`[figbridge] fatal: ${e && e.stack || e}\n`);
  process.exit(1);
});
