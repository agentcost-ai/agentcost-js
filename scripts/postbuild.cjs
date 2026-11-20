// Mark each build's module format so Node resolves .js files correctly.
const fs = require("node:fs");
fs.writeFileSync("dist/cjs/package.json", JSON.stringify({ type: "commonjs" }) + "\n");
fs.writeFileSync("dist/esm/package.json", JSON.stringify({ type: "module" }) + "\n");
if (fs.existsSync("dist-test")) fs.writeFileSync("dist-test/package.json", JSON.stringify({ type: "module" }) + "\n");
