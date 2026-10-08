import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const server = JSON.parse(readFileSync("server.json", "utf8"));
server.version = version;
for (const entry of server.packages ?? []) {
  entry.version = version;
}
writeJson("server.json", server);

const plugin = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8"));
plugin.version = version;
writeJson(".claude-plugin/plugin.json", plugin);

writeFileSync("src/version.ts", `export const VERSION = "${version}";\n`);

console.log(`synced release metadata to ${version}`);
