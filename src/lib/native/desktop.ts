import { invoke } from "@tauri-apps/api/core";

type DesktopCommand =
  | {
      kind: "windowMinimize";
    }
  | {
      kind: "windowToggleMaximize";
    }
  | {
      kind: "windowClose";
    }
  | {
      kind: "openDirectory";
      path: string;
    };

async function performDesktopCommand(command: DesktopCommand): Promise<void> {
  await invoke("perform_desktop_command", { command });
}

export async function minimizeWindow(): Promise<void> {
  await performDesktopCommand({ kind: "windowMinimize" });
}

export async function toggleMaximizeWindow(): Promise<void> {
  await performDesktopCommand({ kind: "windowToggleMaximize" });
}

export async function closeWindow(): Promise<void> {
  await performDesktopCommand({ kind: "windowClose" });
}

export async function openDirectoryInFileManager(path: string): Promise<void> {
  const trimmed = path.trim();

  if (!trimmed) {
    throw new Error("数据目录尚未加载完成。");
  }

  await performDesktopCommand({
    kind: "openDirectory",
    path: trimmed,
  });
}
