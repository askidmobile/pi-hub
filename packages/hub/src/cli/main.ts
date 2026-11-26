#!/usr/bin/env node
import { Command } from "commander";
import { AlreadyRunningError, startDaemon } from "../daemon.js";

/** `pi-hub` CLI: `serve` now; `init`, `doctor`, `status` arrive in plan phase 5. */
const program = new Command()
  .name("pi-hub")
  .description("Delegate coding tasks from a senior agent to cheap Pi workers");

program
  .command("serve")
  .description("Run the hub daemon in the foreground (the shim starts it automatically)")
  .action(async () => {
    try {
      const hub = await startDaemon();
      const stop = () => {
        void hub.close().then(() => process.exit(0));
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      process.on("SIGHUP", stop);
    } catch (e) {
      if (e instanceof AlreadyRunningError) {
        console.error(e.message);
        process.exit(3);
      }
      console.error(`pi-hub serve: ${(e as Error).message}`);
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
