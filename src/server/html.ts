export function escapeInlineAsset(source: string, tagName: "script" | "style"): string {
  return source.replace(
    new RegExp(`</${tagName}`, "gi"),
    (closingTag) => `<\\/${closingTag.slice(2)}`,
  );
}
