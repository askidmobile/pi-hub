#!/usr/bin/env node
import { Command } from "commander";
import { loadHub } from "../config/load.js";
import { AlreadyRunningError, startDaemon } from "../daemon.js";
import { providerKeyEnv } from "../pi-rpc/provider-env.js";
import { formatChecks, hasFailures, runDoctor } from "./doctor.js";
import {
  applyInit,
  askAnswers,
  connectPlugin,
  formatActions,
  type InitAnswers,
  splitRepos,
} from "./init.js";
import { formatTasks, listTasks } from "./status.js";

/** `pi-hub` CLI: `serve`, `init`, `doctor`, `status`. */
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

program
  .command("init")
  .description("Create ~/.pi-hub (config, .env, Pi config for workers) and connect the plugin")
  .option("-y, --yes", "non-interactive: take answers from flags and the environment")
  .option("--model <provider/id>", "default worker model")
  .option("--repo <paths>", "allowed repositories, comma-separated")
  .option("--pi-bin <path>", "Pi executable (default: pi)")
  .option(
    "--extension <path>",
    "Pi extension that adds the provider (repeatable)",
    (v: string, all: string[]) => [...all, v],
    [] as string[],
  )
  .option("--no-plugin", "do not connect the Claude Code plugin")
  .option("--no-check", "skip the final doctor checks")
  .action(
    async (opts: {
      yes?: boolean;
      model?: string;
      repo?: string;
      piBin?: string;
      extension: string[];
      plugin: boolean;
      check: boolean;
    }) => {
      const { paths, config } = loadHub();
      const existingModel = config.roles[config.default_role]?.model;
      let answers: InitAnswers;
      if (existingModel) {
        console.log(`Конфиг уже есть (${paths.config}), вопросы пропущены.`);
        answers = { model: existingModel, allowedRepos: config.allowed_repos };
      } else if (opts.yes) {
        if (!opts.model) {
          console.error("pi-hub init --yes: укажите --model <провайдер>/<id модели>");
          process.exit(2);
        }
        answers = {
          model: opts.model,
          allowedRepos: splitRepos(opts.repo ?? ""),
          piBin: opts.piBin,
          extensions: splitRepos(opts.extension.join(",")),
        };
      } else {
        answers = { ...(await askAnswers()), piBin: opts.piBin };
      }
      // Non-interactive key: the provider's own variable from the caller's environment
      // (no key on the command line, where it would land in shell history).
      const keyVar = providerKeyEnv(answers.model.split("/")[0] ?? "");
      if (!answers.apiKey && keyVar && process.env[keyVar]) answers.apiKey = process.env[keyVar];

      const result = applyInit(answers);
      console.log(`pi-hub: ${result.paths.home}\n${formatActions(result.actions)}`);

      if (opts.plugin) {
        const plugin = await connectPlugin();
        if (plugin.done) console.log("Плагин Claude Code подключён (pi-hub@pi-hub-local).");
        else {
          if (plugin.error) console.log(`Плагин не подключился: ${plugin.error}`);
          console.log(
            `Подключите плагин Claude Code вручную:\n${plugin.commands.map((c) => `  ${c}`).join("\n")}`,
          );
        }
      }

      if (opts.check) {
        const checks = await runDoctor();
        console.log(`\n${formatChecks(checks)}`);
        if (hasFailures(checks)) process.exitCode = 1;
      }
    },
  );

program
  .command("doctor")
  .description("Check config, provider key, Pi version and model, extension, git, daemon")
  .action(async () => {
    const checks = await runDoctor();
    console.log(formatChecks(checks));
    if (hasFailures(checks)) process.exitCode = 1;
  });

program
  .command("status")
  .description("Tasks of all sessions (read-only)")
  .option("-n, --limit <n>", "how many recent tasks", "50")
  .action((opts: { limit: string }) => {
    console.log(formatTasks(listTasks(process.env, Number.parseInt(opts.limit, 10) || 50)));
  });

await program.parseAsync(process.argv);
