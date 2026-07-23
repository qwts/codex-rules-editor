import assert from "node:assert/strict";
import test from "node:test";
import { escapeInlineAsset } from "../src/server/html.ts";

test("escapes closing tags in inline script and style assets", () => {
  assert.equal(
    escapeInlineAsset('const marker = "</script>"; // </SCRIPT>', "script"),
    'const marker = "<\\/script>"; // <\\/SCRIPT>',
  );
  assert.equal(
    escapeInlineAsset('a::after { content: "</style>"; }', "style"),
    'a::after { content: "<\\/style>"; }',
  );
});
