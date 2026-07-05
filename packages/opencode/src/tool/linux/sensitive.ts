import path from "path"

const basename = (value: string) => path.basename(value.replaceAll("\\", "/"))

function sensitive(value: string) {
  const normalized = value.replaceAll("\\", "/")
  return (
    basename(normalized) === ".env" ||
    basename(normalized).startsWith(".env.") ||
    normalized === "secrets" ||
    normalized.startsWith("secrets/") ||
    normalized.endsWith("/secrets") ||
    normalized.includes("/secrets/")
  )
}

export function sensitivePatterns(values: readonly string[]) {
  return [...new Set(values.filter((value) => value && sensitive(value)))]
}
