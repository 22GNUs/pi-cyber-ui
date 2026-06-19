import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CyberUiProfile = "safe" | "full";

interface ProfileConfig {
  profile?: CyberUiProfile;
}

interface ResolvedProfile {
  profile: CyberUiProfile;
  source: "env" | "config" | "default";
  configPath: string;
}

const PROFILE_CONFIG_PATH = join(getAgentDir(), "pi-cyber-ui.json");

function parseProfile(value: unknown): CyberUiProfile | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "safe" || normalized === "full" ? normalized : undefined;
}

function readProfileConfig(): ProfileConfig {
  if (!existsSync(PROFILE_CONFIG_PATH)) return {};

  try {
    const raw = readFileSync(PROFILE_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as ProfileConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function resolveCyberUiProfile(): ResolvedProfile {
  const envProfile = parseProfile(process.env.PI_CYBER_UI_PROFILE);
  if (envProfile) {
    return { profile: envProfile, source: "env", configPath: PROFILE_CONFIG_PATH };
  }

  const configProfile = parseProfile(readProfileConfig().profile);
  if (configProfile) {
    return { profile: configProfile, source: "config", configPath: PROFILE_CONFIG_PATH };
  }

  return { profile: "safe", source: "default", configPath: PROFILE_CONFIG_PATH };
}

function writeProfileConfig(profile: CyberUiProfile): void {
  mkdirSync(dirname(PROFILE_CONFIG_PATH), { recursive: true });
  writeFileSync(
    PROFILE_CONFIG_PATH,
    `${JSON.stringify({ profile } satisfies ProfileConfig, null, 2)}\n`,
    "utf8",
  );
}

export function registerProfileCommand(pi: ExtensionAPI): void {
  pi.registerCommand("cyber-profile", {
    description: "Show or switch pi-cyber-ui profile (safe/full), persisted globally",
    getArgumentCompletions(prefix) {
      const options = ["safe", "full", "toggle", "status"];
      const normalized = prefix.trim().toLowerCase();
      return options
        .filter((option) => option.startsWith(normalized))
        .map((option) => ({ value: option, label: option }));
    },
    async handler(args, ctx) {
      const current = resolveCyberUiProfile();
      const requested = args.trim().toLowerCase();

      let next: CyberUiProfile | undefined;
      if (!requested || requested === "status") {
        if (!requested && ctx.hasUI) {
          const choice = await ctx.ui.select("pi-cyber-ui profile", ["safe", "full"]);
          next = parseProfile(choice);
          if (!next) return;
        } else {
          ctx.ui.notify(
            `pi-cyber-ui profile: ${current.profile} (${current.source}); config: ${current.configPath}`,
            "info",
          );
          return;
        }
      } else if (requested === "toggle") {
        next = current.profile === "full" ? "safe" : "full";
      } else {
        next = parseProfile(requested);
      }

      if (!next) {
        ctx.ui.notify("Usage: /cyber-profile [safe|full|toggle|status]", "error");
        return;
      }

      writeProfileConfig(next);

      if (process.env.PI_CYBER_UI_PROFILE) {
        // Let this command take effect for the current process, while still
        // preserving the setting for launches that do not set the env var.
        process.env.PI_CYBER_UI_PROFILE = next;
      }

      ctx.ui.notify(
        `pi-cyber-ui profile saved: ${next}. Reloading...`,
        "info",
      );
      await ctx.reload();
      return;
    },
  });
}
