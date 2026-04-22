#!/usr/bin/env node

// Executable entrypoint for the Strada CLI. Parses argv and delegates to cli.ts.

import { cli } from "./cli.ts";

cli.parse();
