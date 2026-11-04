import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const { resolveVaultPaths } = await import("../lib/engine/utils.js");
const { getWikiStatus } = await import("../lib/engine/wiki-service.js");
const { searchWiki } = await import("../lib/engine/recall.js");

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const countSources = (wikiDir) => {
  try {
    return readdirSync(join(wikiDir, "sources")).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
};

// Resolve through the same logic the tools use: cwd inside $HOME has no
// project vault, so resolution falls through to the personal vault root.
const paths = resolveVaultPaths(homedir());
const registryPath = join(paths.dotWiki, "meta", "registry.json");

const before = {
  registry: statSync(registryPath),
  sources: countSources(paths.wiki),
};

const status = await getWikiStatus(paths);
const config = JSON.parse(readFileSync(join(paths.dotWiki, "config.json"), "utf8"));

console.log(`vault_root: ${paths.root}`);
console.log(`knowledge_format: ${status.knowledgeFormat}`);
console.log(`vault_id: ${config.vault_id}`);
console.log(`pages_total: ${status.totalPages}`);
for (const [type, count] of Object.entries(status.byType).sort()) {
  console.log(`pages.${type}: ${count}`);
}

if (status.knowledgeFormat !== "okf-0.2") fail(`unexpected knowledge_format ${status.knowledgeFormat}`);
if (status.totalPages === 0) fail("zero pages in registry");
if (!status.byType.source) fail("no source pages");

const hits = searchWiki(paths, "超星", 3);
console.log("search '超星' top hits:");
for (const hit of hits) {
  console.log(`  ${hit.id} | ${hit.title} | score ${hit.score.toFixed(1)}`);
}
if (hits.length === 0) fail("zero search hits for 超星");

const after = {
  registry: statSync(registryPath),
  sources: countSources(paths.wiki),
};

console.log(`registry.json before: mtime=${before.registry.mtimeMs} size=${before.registry.size}`);
console.log(`registry.json after:  mtime=${after.registry.mtimeMs} size=${after.registry.size}`);
console.log(`wiki/sources files before: ${before.sources} after: ${after.sources}`);

if (before.registry.mtimeMs !== after.registry.mtimeMs || before.registry.size !== after.registry.size) {
  fail("registry.json changed — run was not read-only");
}
if (before.sources !== after.sources) fail("wiki/sources file count changed");

console.log("OK: read-only smoke passed");
