#!/usr/bin/env node
// Concatenates the user-facing docs into llms-full.txt for AI answer engines.
import { readFileSync, writeFileSync } from "node:fs";

const files = [
  "README.md",
  "docs/clients/README.md",
  "docs/clients/claude-ai.md",
  "docs/clients/claude-desktop-code.md",
  "docs/clients/chatgpt.md",
  "docs/clients/cursor.md",
  "docs/clients/vscode.md",
  "docs/clients/muse.md",
  "docs/clients/generic.md",
  "docs/CLIENTS.md",
  "docs/COMPATIBILITY.md",
  "docs/PLATFORM.md",
  "SECURITY.md",
  "docs/INSTALL.md",
  "docs/ADDING_A_TOOL.md",
];
const out = files
  .map((f) => `<!-- ${f} -->\n\n${readFileSync(f, "utf8").trim()}\n`)
  .join("\n---\n\n");
writeFileSync("llms-full.txt", `# mcp-mail — full documentation\n\n${out}`);
console.log(`llms-full.txt: ${files.length} files`);
