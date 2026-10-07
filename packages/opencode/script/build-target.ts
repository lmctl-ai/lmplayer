export type BuildTarget = {
  os: "linux" | "darwin" | "win32"
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}

export const allTargets: readonly BuildTarget[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

export function targetSuffix(target: BuildTarget) {
  return [
    target.os === "win32" ? "windows" : target.os,
    target.arch,
    target.avx2 === false ? "baseline" : undefined,
    target.abi,
  ]
    .filter(Boolean)
    .join("-")
}

export function targetForSuffix(suffix: string) {
  return allTargets.find((target) => targetSuffix(target) === suffix)
}

export function targetName(target: BuildTarget, prefix = "lmplayer") {
  return `${prefix}-${targetSuffix(target)}`
}
