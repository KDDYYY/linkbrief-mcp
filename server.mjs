#!/usr/bin/env node
// MCP server over stdio: gives the agent fetch_page, fetch_pages and fetch_site (defined in tools.mjs).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// stdout carries the MCP protocol; a library warning printed there (pdf.js does) would corrupt it.
console.log = console.info = console.debug = console.error;

// Imported after the override so warnings printed while modules load also go to stderr.
const { createServer } = await import("./tools.mjs");
await createServer().connect(new StdioServerTransport());
