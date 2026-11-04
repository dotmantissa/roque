import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";

const web = createRequire(import.meta.url);
const dependency = (parent, name) => {
  // Some SDKs expose only ESM subpaths. Resolve their installed package root
  // without importing browser code or assuming a CommonJS main export.
  for (const directory of parent.resolve.paths(name) ?? []) {
    const manifest = join(directory, name, "package.json");
    if (existsSync(manifest)) return createRequire(realpathSync(manifest));
  }
  throw new Error(`Missing wallet dependency: ${name}`);
};
const privy = dependency(web, "@privy-io/react-auth");
const connectors = dependency(dependency(dependency(privy, "x402"), "wagmi"), "@wagmi/connectors");
const utils = dependency(dependency(connectors, "@walletconnect/ethereum-provider"), "@walletconnect/utils");
const query = dependency(utils, "query-string");

test("WalletConnect parses encoded URI data with the patched CommonJS/ESM decoder", async () => {
  const decoder = query("decode-uri-component");
  const esm = await import(pathToFileURL(query.resolve("decode-uri-component")).href);
  assert.equal(esm.default, decoder);
  assert.equal(decoder("hello%20%C3%A5%25"), "hello å%");
  assert.throws(() => decoder(null), TypeError);
  assert.deepEqual({ ...utils("query-string").parse("relay-protocol=irn&label=hello%20%C3%A5%25") }, {
    "relay-protocol": "irn", label: "hello å%",
  });
  // A separate process makes the time bound effective even if a vulnerable
  // synchronous decoder would otherwise block the test runner's event loop.
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", `
    const assert = require("node:assert/strict");
    const { readFileSync } = require("node:fs");
    const query = require(JSON.parse(readFileSync(0, "utf8")));
    for (const unit of ["%FF", "%C2", "%E0%A4", "%25%FF", "%F0%9F%92"]) {
      const malformed = unit.repeat(8192);
      const parsed = query.parse("key=" + malformed);
      assert.equal(typeof parsed.key, "string");
      assert.ok(parsed.key.length <= malformed.length);
    }
  `], { input: JSON.stringify(utils.resolve("query-string")), timeout: 5000, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test("MetaMask retains UUID v4 and rejects undersized v5 output buffers", () => {
  const metamask = dependency(connectors, "@metamask/sdk");
  const uuid = metamask("uuid");
  assert.ok(uuid.validate(uuid.v4()));
  assert.equal(uuid.version(uuid.v4()), 4);
  assert.throws(() => uuid.v5("roque", uuid.v5.DNS, new Uint8Array(1)), RangeError);
  const communication = dependency(metamask, "@metamask/sdk-communication-layer");
  assert.ok(communication("uuid").validate(communication("uuid").v4()));
});

test("Next's patched Sharp dependency decodes and resizes a real image", async () => {
  const sharp = dependency(web, "next")("sharp");
  const original = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#003dad" } }).png().toBuffer();
  const output = await sharp(original).resize(4, 4).webp().toBuffer();
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 4);
  assert.equal(metadata.height, 4);
});
