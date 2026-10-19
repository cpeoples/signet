#!/usr/bin/env node
import { run } from "./command.js";

process.exitCode = run(process.argv.slice(2));
