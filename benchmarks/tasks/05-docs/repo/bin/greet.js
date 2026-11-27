#!/usr/bin/env node
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    name: { type: "string", default: "world" },
    shout: { type: "boolean", default: false },
    times: { type: "string", default: "1" },
  },
});
let line = `Hello, ${values.name}!`;
if (values.shout) line = line.toUpperCase();
for (let i = 0; i < Number(values.times); i++) console.log(line);
