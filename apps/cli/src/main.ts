#!/usr/bin/env node
import { interactive, run } from "./cli.ts";

// Ctrl-C stops the run without a report: a visit cut short says nothing about the link. A second
// Ctrl-C ends the process at once.
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());

const args = process.argv.slice(2);
if (args.includes("-i") || args.includes("--interactive")) {
  // Ask for links one after another, reading from the terminal.
  await interactive(process.stdin, process.stdout, { signal: stop.signal });
} else {
  process.exitCode = await run(
    args,
    { out: (text) => console.log(text), err: (text) => console.error(text) },
    { signal: stop.signal },
  );
}
