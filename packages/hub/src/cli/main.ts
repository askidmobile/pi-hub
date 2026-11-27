#!/usr/bin/env node
import { Command } from "commander";
import { loadHub } from "../config/load.js";
import { AlreadyRunningError, startDaemon } from "../daemon.js";
import { providerKeyEnv } from "../pi-rpc/provider-env.js";
import { formatChecks, hasFailures, runDoctor } from "./doctor.js";
import {
  applyInit,
  askAnswers,
  askRouter,
  connectPlugin,
  formatActions,
  type InitAnswers,
  splitRepos,
} from "./init.js";
import {
  formatRouterStatus,
  formatRouterTest,
  RESTART_HINT,
  type RouterAnswers,
  routerState,
  routerTest,
  writeRouterConfig,
} from "./router.js";
import { formatTasks, listTasks } from "./status.js";

interface RouterFlags {
  router?: string;
  routerPreset?: string;
  routerModel?: string;
  routerKeyEnv?: string;
  routerUrl?: string;
}

/** Router answers from flags; undefined when no router flag was given. */
function routerFromFlags(o: RouterFlags): RouterAnswers | undefined {
  if (o.router === "off") return { smart: false };
  if (!o.routerPreset && !o.routerUrl && o.router !== "on") return undefined;
  return {
    smart: true,
    preset: o.routerPreset ?? (o.routerUrl ? "custom" : "9router"),
    ...(o.routerUrl ? { url: o.routerUrl } : {}),
    ...(o.routerModel ? { model: o.routerModel } : {}),
    ...(o.routerKeyEnv ? { api_key_env: o.routerKeyEnv } : {}),
  };
}

/** After the router config changed: the key hint, a test when the key is there. */
async function afterRouterChange(r: RouterAnswers): Promise<void> {
  if (!r.smart) {
    console.log("Умный роутер выключен.");
    return;
  }
  let state: ReturnType<typeof routerState>;
  try {
    state = routerState();
  } catch (e) {
    console.log(`Конфиг роутера не прошёл проверку: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  console.log(formatRouterStatus(state));
  if (!state.keySet) {
    console.log(`Положите ${state.keyEnv}=… в ~/.pi-hub/.env и проверьте: pi-hub router test`);
    return;
  }
  try {
    console.log(formatRouterTest(await routerTest()));
  } catch (e) {
    console.log(`Тестовый вопрос не прошёл: ${(e as Error).message}`);
  }
}

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
  .option("--router <on|off>", "smart router (System One) on with --router-preset, or off")
  .option("--router-preset <id>", "System One preset: 9router, typesafe, openrouter, ollama, …")
  .option("--router-model <id>", "System One model (default: the preset's)")
  .option("--router-key-env <name>", "variable of the System One key in ~/.pi-hub/.env")
  .option("--router-url <url>", "System One URL for a custom endpoint")
  .option("--no-plugin", "do not connect the Claude Code plugin")
  .option("--no-check", "skip the final doctor checks")
  .action(
    async (
      opts: {
        yes?: boolean;
        model?: string;
        repo?: string;
        piBin?: string;
        extension: string[];
        plugin: boolean;
        check: boolean;
      } & RouterFlags,
    ) => {
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

      // Smart router (stage 3 FR-223): flags, else one question when it is not set up yet.
      const router =
        routerFromFlags(opts) ??
        (!opts.yes && !config.router.system_one && process.stdin.isTTY
          ? await askRouter()
          : undefined);
      if (router && writeRouterConfig(result.paths.config, router)) {
        console.log(`  ${result.paths.config} — роутер записан`);
        await afterRouterChange(router);
        if (existingModel) console.log(RESTART_HINT);
      }

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

const routerCmd = program
  .command("router")
  .description("Smart router (System One): status, a test question, turn off");
routerCmd
  .command("status", { isDefault: true })
  .description("Router config, key, roles, failures in a row")
  .action(() => {
    try {
      console.log(formatRouterStatus(routerState()));
    } catch (e) {
      console.error(`pi-hub router status: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });
routerCmd
  .command("test")
  .description("Send one test question and print model, latency, answer and cost")
  .action(async () => {
    try {
      console.log(formatRouterTest(await routerTest()));
    } catch (e) {
      console.error(`pi-hub router test: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });
routerCmd
  .command("off")
  .description("Turn the smart router off (System One settings are kept)")
  .action(() => {
    const { paths } = loadHub();
    if (writeRouterConfig(paths.config, { smart: false })) {
      console.log(`Умный роутер выключен.\n${RESTART_HINT}`);
    } else console.log("Умный роутер уже выключен.");
  });

program
  .command("status")
  .description("Tasks of all sessions (read-only)")
  .option("-n, --limit <n>", "how many recent tasks", "50")
  .action((opts: { limit: string }) => {
    console.log(formatTasks(listTasks(process.env, Number.parseInt(opts.limit, 10) || 50)));
  });

await program.parseAsync(process.argv);
