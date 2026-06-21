import fs from "node:fs"

import { app, protocol } from "electron"
import path from "pathe"

const e2eUserDataDir = process.env.FOCAL_E2E_USER_DATA_DIR

const hasProfileData = (profileDir: string) => {
  const dbJsonPath = path.join(profileDir, "db.json")
  const indexedDbPath = path.join(profileDir, "IndexedDB", "http_localhost_5173.indexeddb.leveldb")

  const dbJsonHasData = fs.existsSync(dbJsonPath) && fs.statSync(dbJsonPath).size > 100
  const indexedDbHasData = fs.existsSync(indexedDbPath) && fs.readdirSync(indexedDbPath).length > 10

  return dbJsonHasData || indexedDbHasData
}

const migrateLegacyDevUserData = (appDataPath: string) => {
  const userDataDir = path.join(appDataPath, "FinHot(dev)")
  const legacyUserDataDir = path.join(appDataPath, "Folo(dev)")

  if (!fs.existsSync(legacyUserDataDir)) {
    return userDataDir
  }

  if (hasProfileData(userDataDir) || !hasProfileData(legacyUserDataDir)) {
    return userDataDir
  }

  if (fs.existsSync(userDataDir)) {
    fs.renameSync(userDataDir, `${userDataDir}.pre-migration-${Date.now()}`)
  }

  fs.cpSync(legacyUserDataDir, userDataDir, { recursive: true })
  return userDataDir
}

if (e2eUserDataDir) {
  app.setPath("userData", e2eUserDataDir)
} else if (import.meta.env.DEV) {
  app.setPath("userData", migrateLegacyDevUserData(app.getPath("appData")))
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      bypassCSP: true,
      supportFetchAPI: true,
      secure: true,
    },
  },
])
