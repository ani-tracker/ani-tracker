import { spawn } from "node:child_process";
import { shell } from "electron";
import type { AppSettings, PlayerProfile } from "@shared/domain";

export class PlayerLauncherService {
  constructor(private readonly settings: AppSettings) {}

  async play(filePath: string, profileId?: string): Promise<void> {
    const profile = this.resolveProfile(profileId);

    if (!profile) {
      await shell.openPath(filePath);
      return;
    }

    const args = buildPlayerArgs(profile.argumentTemplate, filePath);
    const child = spawn(profile.executablePath, args, {
      detached: true,
      stdio: "ignore"
    });

    child.unref();
  }

  static reveal(filePath: string): void {
    shell.showItemInFolder(filePath);
  }

  private resolveProfile(profileId?: string): PlayerProfile | undefined {
    const targetId = profileId ?? this.settings.defaultPlayerProfileId;
    return this.settings.players.find((profile) => profile.id === targetId) ?? this.settings.players[0];
  }
}

export function buildPlayerArgs(template: string, filePath: string): string[] {
  const rendered = template.replaceAll("{file}", filePath);
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(rendered))) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }

  return args;
}
