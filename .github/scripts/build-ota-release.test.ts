import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { afterEach, describe, expect, it } from "vitest"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
  delete process.env.OTA_PRODUCT
  delete process.env.OTA_GIT_TAG
  delete process.env.OTA_GIT_COMMIT
  delete process.env.OTA_PUBLISHED_AT
  delete process.env.OTA_MIN_SUPPORTED_BINARY_VERSION
  delete process.env.GITHUB_REPOSITORY
})

describe("buildDesktopReleaseAssets", () => {
  it("builds schemaVersion 2 desktop build metadata with direct app payloads only", async () => {
    const { buildDesktopReleaseAssets } = await import("./build-ota-release.mjs")
    const projectDir = await createDesktopProjectFixture({
      version: "1.5.1",
      releaseConfig: {
        version: "1.5.1",
        mode: "build",
        runtimeVersion: null,
        channel: null,
      },
      manifests: [
        {
          relativeDir: join("out", "make", "squirrel.windows", "x64"),
          manifestName: "latest.yml",
          contents: `
version: 1.5.1
files:
  - url: Focal-1.5.1-windows-x64.exe
    sha512: ${"a".repeat(88)}
    size: 123456
releaseDate: 2026-04-11T10:00:00.000Z
`,
        },
      ],
    })

    const result = await buildDesktopReleaseAssets({
      projectDir,
      owner: "nextcaicai",
      repo: "Focal",
    })

    expect(result.otaMetadata.schemaVersion).toBe(2)
    expect(result.otaMetadata.product).toBe("desktop")
    expect(result.otaMetadata.releaseKind).toBe("binary")
    expect(result.otaMetadata.runtimeVersion).toBeNull()
    expect(result.otaMetadata.channel).toBe("stable")
    expect(result.otaMetadata.desktop.renderer).toBeNull()
    expect(result.otaMetadata.policy.distributions).toEqual({})
    expect(result.otaMetadata.desktop.app.platforms.windows).toEqual(
      expect.objectContaining({
        platform: "windows-x64",
        releaseDate: "2026-04-11T10:00:00.000Z",
        manifest: {
          name: "latest.yml",
          path: "latest.yml",
          downloadUrl: expect.stringContaining("/desktop/v1.5.1/latest.yml"),
        },
        files: [
          expect.objectContaining({
            filename: "Focal-1.5.1-windows-x64.exe",
            sha512: "a".repeat(88),
            size: 123456,
            downloadUrl: expect.stringContaining("/desktop/v1.5.1/Focal-1.5.1-windows-x64.exe"),
          }),
        ],
      }),
    )
    expect(result.archivePath).toBeNull()

    const written = JSON.parse(await readFile(result.outputPath, "utf8"))
    expect(written.schemaVersion).toBe(2)
    expect(written.desktop.renderer).toBeNull()
  })

  it("builds schemaVersion 2 desktop ota metadata with renderer and direct app payloads", async () => {
    const { buildDesktopReleaseAssets } = await import("./build-ota-release.mjs")
    const projectDir = await createDesktopProjectFixture({
      version: "1.5.1",
      releaseConfig: {
        version: "1.5.1",
        mode: "ota",
        runtimeVersion: "1.5.0",
        channel: "stable",
      },
      rendererArchiveContents: "renderer archive",
      rendererManifestContents: `
version: 1.5.1
hash: ${"b".repeat(64)}
mainHash: ${"c".repeat(40)}
commit: abcdef1234567890
filename: custom-renderer.tar.gz
`,
      manifests: [
        {
          relativeDir: join("out", "make", "squirrel.windows", "x64"),
          manifestName: "latest.yml",
          contents: `
version: 1.5.1
files:
  - url: Focal-1.5.1-windows-x64.exe
    sha512: ${"d".repeat(88)}
    size: 654321
releaseDate: 2026-04-11T10:00:00.000Z
`,
        },
      ],
    })

    const result = await buildDesktopReleaseAssets({
      projectDir,
      owner: "nextcaicai",
      repo: "Focal",
    })

    expect(result.otaMetadata.schemaVersion).toBe(2)
    expect(result.otaMetadata.releaseKind).toBe("ota")
    expect(result.otaMetadata.runtimeVersion).toBe("1.5.0")
    expect(result.otaMetadata.channel).toBe("stable")
    expect(result.otaMetadata.desktop.renderer).toEqual(
      expect.objectContaining({
        version: "1.5.1",
        commit: "abcdef1234567890",
        manifest: {
          name: "manifest.yml",
          downloadUrl:
            "https://github.com/nextcaicai/Focal/releases/download/desktop/v1.5.1/manifest.yml",
        },
        launchAsset: expect.objectContaining({
          path: "custom-renderer.tar.gz",
          contentType: "application/gzip",
        }),
      }),
    )
    expect(result.otaMetadata.desktop.renderer.launchAsset.sha256).toHaveLength(64)
    expect(result.otaMetadata.desktop.app.platforms.windows.files[0]?.downloadUrl).toContain(
      "/desktop/v1.5.1/Focal-1.5.1-windows-x64.exe",
    )
    expect(result.archivePath).not.toBeNull()
  })

  it("fails when a desktop manifest contains an invalid file entry", async () => {
    const { buildDesktopReleaseAssets } = await import("./build-ota-release.mjs")
    const projectDir = await createDesktopProjectFixture({
      version: "1.5.1",
      releaseConfig: {
        version: "1.5.1",
        mode: "build",
        runtimeVersion: null,
        channel: null,
      },
      manifests: [
        {
          relativeDir: join("out", "make", "squirrel.windows", "x64"),
          manifestName: "latest.yml",
          contents: `
version: 1.5.1
files:
  - url: Focal-1.5.1-windows-x64.exe
    size: 123456
releaseDate: 2026-04-11T10:00:00.000Z
`,
        },
      ],
    })

    await expect(
      buildDesktopReleaseAssets({
        projectDir,
        owner: "nextcaicai",
        repo: "Focal",
      }),
    ).rejects.toThrow(/invalid files\[0\] entry/i)
  })

  it("fails for build mode when direct installer manifests are missing", async () => {
    const { buildDesktopReleaseAssets } = await import("./build-ota-release.mjs")
    const projectDir = await createDesktopProjectFixture({
      version: "1.5.1",
      releaseConfig: {
        version: "1.5.1",
        mode: "build",
        runtimeVersion: null,
        channel: null,
      },
    })

    await expect(
      buildDesktopReleaseAssets({
        projectDir,
        owner: "nextcaicai",
        repo: "Focal",
      }),
    ).rejects.toThrow(/requires direct installer manifests/i)
  })

  it("fails for ota mode when direct installer manifests are missing", async () => {
    const { buildDesktopReleaseAssets } = await import("./build-ota-release.mjs")
    const projectDir = await createDesktopProjectFixture({
      version: "1.5.1",
      releaseConfig: {
        version: "1.5.1",
        mode: "ota",
        runtimeVersion: "1.5.0",
        channel: "stable",
      },
      rendererArchiveContents: "renderer archive",
      rendererManifestContents: `
version: 1.5.1
hash: ${"2".repeat(64)}
mainHash: ${"3".repeat(40)}
commit: abcdef1234567890
filename: custom-renderer.tar.gz
`,
    })

    await expect(
      buildDesktopReleaseAssets({
        projectDir,
        owner: "nextcaicai",
        repo: "Focal",
      }),
    ).rejects.toThrow(/requires direct installer manifests/i)
  })

  it("merges duplicate desktop platform manifests instead of overwriting them", async () => {
    const { buildDesktopReleaseAssets } = await import("./build-ota-release.mjs")
    const projectDir = await createDesktopProjectFixture({
      version: "1.5.1",
      releaseConfig: {
        version: "1.5.1",
        mode: "build",
        runtimeVersion: null,
        channel: null,
      },
      manifests: [
        {
          relativeDir: join("out", "make", "squirrel.windows", "x64"),
          manifestName: "latest.yml",
          contents: `
version: 1.5.1
files:
  - url: Focal-1.5.1-windows-x64.exe
    sha512: ${"e".repeat(88)}
    size: 123456
releaseDate: 2026-04-11T10:00:00.000Z
`,
        },
        {
          relativeDir: join("out", "make", "squirrel.windows", "arm64"),
          manifestName: "latest.yml",
          contents: `
version: 1.5.1
files:
  - url: Focal-1.5.1-windows-arm64.exe
    sha512: ${"f".repeat(88)}
    size: 234567
releaseDate: 2026-04-11T11:00:00.000Z
`,
        },
      ],
    })

    const result = await buildDesktopReleaseAssets({
      projectDir,
      owner: "nextcaicai",
      repo: "Focal",
    })

    expect(result.otaMetadata.desktop.app.platforms.windows.files).toHaveLength(2)
    expect(result.otaMetadata.desktop.app.platforms.windows.releaseDate).toBe(
      "2026-04-11T11:00:00.000Z",
    )
  })
})

async function createDesktopProjectFixture(input: {
  version: string
  releaseConfig: {
    version: string
    mode: "build" | "ota"
    runtimeVersion: string | null
    channel: "stable" | "beta" | "alpha" | null
  }
  manifests?: Array<{
    relativeDir: string
    manifestName: string
    contents: string
  }>
  rendererArchiveContents?: string
  rendererManifestContents?: string
}) {
  const projectDir = await mkdtemp(join(tmpdir(), "build-ota-release-desktop-test-"))
  tempDirs.push(projectDir)

  await writeFile(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "@follow/desktop-test", version: input.version }),
    "utf8",
  )
  await writeFile(
    join(projectDir, "release.json"),
    `${JSON.stringify(input.releaseConfig, null, 2)}\n`,
    "utf8",
  )

  if (input.rendererArchiveContents != null || input.rendererManifestContents != null) {
    await mkdir(join(projectDir, "dist"), { recursive: true })
  }

  if (input.rendererArchiveContents != null) {
    await writeFile(
      join(
        projectDir,
        "dist",
        input.rendererManifestContents?.includes("custom-renderer.tar.gz")
          ? "custom-renderer.tar.gz"
          : "render-asset.tar.gz",
      ),
      input.rendererArchiveContents,
      "utf8",
    )
  }

  if (input.rendererManifestContents != null) {
    await writeFile(
      join(projectDir, "dist", "manifest.yml"),
      input.rendererManifestContents.trimStart(),
      "utf8",
    )
  }

  for (const manifest of input.manifests ?? []) {
    await mkdir(join(projectDir, manifest.relativeDir), { recursive: true })
    await writeFile(
      join(projectDir, manifest.relativeDir, manifest.manifestName),
      manifest.contents.trimStart(),
      "utf8",
    )
  }

  return projectDir
}
