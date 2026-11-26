/**
 * System One provider presets offered by `pi-hub init`. Data, not code: add or edit entries freely.
 * See docs/adr/0008-smart-router-setup.md and docs/research/system-one.md.
 */
export type Dialect = "systemone" | "cloudflare-run";

export interface SystemOnePreset {
  id: string;
  label: string;
  url: string; // may contain {account_id}
  dialect: Dialect;
  apiKeyEnv?: string; // undefined = no key needed
  models: string[];
}

export const SYSTEM_ONE_PRESETS: readonly SystemOnePreset[] = [
  {
    // Default: TypeSafe created Jev and the System One API. Docs: https://docs.typesafe.ai
    id: "typesafe",
    label: "TypeSafe (Jev, direct)",
    url: "https://api.typesafe.ai/v1/systemone",
    dialect: "systemone",
    apiKeyEnv: "TYPESAFE_API_KEY",
    models: ["jev-latest", "jev-1.14.0", "jev-1.13.0", "jev-preview"],
  },
  {
    id: "openrouter",
    label: "OpenRouter (TypeSafe Jev)",
    url: "https://openrouter.ai/api/v1/systemone",
    dialect: "systemone",
    apiKeyEnv: "OPENROUTER_API_KEY",
    models: ["typesafe/jev-latest", "typesafe/jev-1.13"],
  },
  {
    id: "aimlapi",
    label: "AIML API (TypeSafe Jev)",
    url: "https://api.aimlapi.com/v1/decisions",
    dialect: "systemone",
    apiKeyEnv: "AIMLAPI_KEY",
    models: ["typesafe/jev", "typesafe/jev-1.14"],
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    url: "http://localhost:11434/v1/systemone",
    dialect: "systemone",
    models: ["nimble"],
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud (Clef)",
    url: "https://ollama.com/v1/systemone",
    dialect: "systemone",
    apiKeyEnv: "OLLAMA_API_KEY",
    models: ["clef:cloud"],
  },
  {
    id: "cloudflare",
    label: "Cloudflare Workers AI (Clef)",
    url: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run",
    dialect: "cloudflare-run",
    apiKeyEnv: "CLOUDFLARE_API_TOKEN",
    models: ["@cf/cloudflare/clef-flash", "@cf/cloudflare/clef"],
  },
  {
    id: "litellm",
    label: "LiteLLM proxy",
    url: "http://localhost:4000/v1/systemone",
    dialect: "systemone",
    apiKeyEnv: "LITELLM_API_KEY",
    models: [],
  },
  {
    id: "custom",
    label: "Custom System One-compatible URL",
    url: "",
    dialect: "systemone",
    models: [],
  },
];
