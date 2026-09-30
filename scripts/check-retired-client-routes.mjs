import { readFile } from "node:fs/promises";
import path from "node:path";

const RETIRED_CLIENT_ROUTE_PATTERNS = [
  /\/api\/v1\/pos\/checkouts\b/,
  /\/api\/operator\/esb\/inventory(?:\/|\b)/,
];

const CONTRACT_ONLY_FILES = new Set([
  "scripts/check-retired-client-routes.mjs",
  "scripts/check-reliability-openapi.mjs",
  "scripts/check.mjs",
  "src/api/v1.mjs",
  "src/pos-alpha/server.mjs",
  "src/services/retired-route-telemetry.mjs",
]);

const NON_RUNTIME_PREFIXES = ["artifacts/", "docs/", "openapi/", "tests/"];
const SOURCE_EXTENSIONS = new Set([
  ".bash", ".cjs", ".cts", ".html", ".js", ".json", ".jsx", ".mjs", ".mts",
  ".ps1", ".sh", ".toml", ".ts", ".tsx", ".yaml", ".yml",
]);

export async function checkRetiredClientRoutes({ appRoot, files }) {
  const candidates = files
    .map((file) => ({ absolute: file, relative: normalize(path.relative(appRoot, file)) }))
    .filter(({ relative }) => !CONTRACT_ONLY_FILES.has(relative))
    .filter(({ relative }) => !NON_RUNTIME_PREFIXES.some((prefix) => relative.startsWith(prefix)))
    .filter(({ relative }) => path.extname(relative) === "" || SOURCE_EXTENSIONS.has(path.extname(relative)));

  for (const candidate of candidates) {
    const source = await readFile(candidate.absolute, "utf8");
    const searchable = collapseStaticStringConcatenations(source);
    if (RETIRED_CLIENT_ROUTE_PATTERNS.some((pattern) => pattern.test(searchable))) {
      throw new Error(`retired_route_client_reference:${candidate.relative}`);
    }
  }

  return { scannedFiles: candidates.length, retiredRouteReferences: 0 };
}

function normalize(value) {
  return value.replaceAll("\\", "/");
}

function collapseStaticStringConcatenations(source) {
  const trivia = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*`;
  const boundary = new RegExp(`["'\\\`]${trivia}\\+${trivia}["'\\\`]`, "g");
  let collapsed = source;
  while (boundary.test(collapsed)) {
    collapsed = collapsed.replace(boundary, "");
    boundary.lastIndex = 0;
  }
  collapsed = collapsed.replace(/\[([\s\S]{1,1000}?)\]\s*\.join\(\s*(["'`])\2\s*\)/g, (full, body) => {
    const literals = parseStaticLiteralList(body);
    return literals ? literals.join("") : full;
  });
  collapsed = collapsed.replace(/((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`))\s*\.concat\(\s*([\s\S]{1,1000}?)\)/g, (full, head, body) => {
    const literals = parseStaticLiteralList(body);
    return literals ? `${literalValue(head)}${literals.join("")}` : full;
  });
  return collapsed;
}

function parseStaticLiteralList(body) {
  const parts = body.split(",").map((part) => part.trim());
  if (!parts.length || parts.some((part) => !/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)$/.test(part))) return null;
  return parts.map(literalValue);
}

function literalValue(literal) {
  return literal.slice(1, -1).replace(/\\([\\"'`])/g, "$1");
}
