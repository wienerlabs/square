import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const APP_DIR = "square";

function root(): string {
  const explicit = process.env.SQUARE_HOME;
  if (explicit) return explicit;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && platform() === "linux") return join(xdg, APP_DIR);
  return join(homedir(), `.${APP_DIR}`);
}

export const paths = {
  root,
  configFile: (): string => join(root(), "config.json"),
  keystoreFile: (): string => join(root(), "keystore.json"),
};

export async function ensureRoot(): Promise<string> {
  const dir = root();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}
