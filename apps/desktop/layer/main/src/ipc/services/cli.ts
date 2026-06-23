import type { IpcContext } from "electron-ipc-decorator"
import { IpcMethod, IpcService } from "electron-ipc-decorator"

export interface CliInstallStatus {
  connected: boolean
  configPath: string
  hasDesktopSession: boolean
  installCommand: string
  loginCommand: string
  npxAvailable: boolean
  packageName: string
}

export class CliService extends IpcService {
  static override readonly groupName = "cli"

  @IpcMethod()
  async getInstallStatus(_context: IpcContext): Promise<CliInstallStatus> {
    return {
      connected: false,
      configPath: "",
      hasDesktopSession: false,
      installCommand: "",
      loginCommand: "",
      npxAvailable: false,
      packageName: "focalcli",
    }
  }

  @IpcMethod()
  async installCli(
    _context: IpcContext,
    _preferredToken?: string,
  ): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: "CLI login sync is disabled in local RSS mode." }
  }

  @IpcMethod()
  async uninstallCli(_context: IpcContext): Promise<{ success: boolean; error?: string }> {
    return { success: true }
  }
}
