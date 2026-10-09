#!/usr/bin/env node
import { run } from "./cli.ts";

// Ctrl-C stops the run without a report: a visit cut short says nothing about the link. A second
// Ctrl-C ends the process at once.
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());

process.exitCode = await run(
  process.argv.slice(2),
  { out: (text) => console.log(text), err: (text) => console.error(text) },
  { signal: stop.signal },
);
