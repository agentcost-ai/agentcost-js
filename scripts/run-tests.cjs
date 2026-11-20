// Runs the compiled test files by explicit path: `node --test <dir>` works on
// Node 18/20 but not 21+, which treat arguments as file patterns.
const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const files = readdirSync("dist-test/test").filter((f) => f.endsWith(".test.js")).map((f) => join("dist-test", "test", f));
files.push(join("test", "cjs-smoke.test.cjs"));
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
