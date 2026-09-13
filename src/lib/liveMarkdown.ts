/** Live composer/edit preview: keep raw only while a construct is still open. */
function lastLine(text: string): string {
  return text.split("\n").pop() ?? "";
}

/** Toggle inline markers on the last line; leftover open state means uncommitted. */
function hasUnclosedInline(text: string): boolean {
  const line = lastLine(text);
  let i = 0;
  let bold = false;
  let italic = false;
  let strike = false;
  let code = false;
  let strongU = false;
  let emU = false;
  while (i < line.length) {
    const ch = line[i] ?? "";
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (!code && line.startsWith("~~", i)) {
      strike = !strike;
      i += 2;
      continue;
    }
    if (!code && line.startsWith("**", i)) {
      bold = !bold;
      i += 2;
      continue;
    }
    if (!code && line.startsWith("__", i)) {
      strongU = !strongU;
      i += 2;
      continue;
    }
    if (ch === "`") {
      code = !code;
      i += 1;
      continue;
    }
    if (!code && ch === "*") {
      italic = !italic;
      i += 1;
      continue;
    }
    if (!code && ch === "_") {
      emU = !emU;
      i += 1;
      continue;
    }
    i += 1;
  }
  return bold || italic || strike || code || strongU || emU;
}

export function isUncommittedMarkdown(text: string): boolean {
  if (!text) return false;
  const line = lastLine(text);
  // A lone `#` / `##` with no title, or a bare list marker, is still being typed.
  if (/^#{1,6}\s*$/.test(line)) return true;
  if (/^(\s*(?:[-+]|\d+\.)|\s*\*)\s*$/.test(line)) return true;
  return hasUnclosedInline(text);
}

export function shouldLiveRenderMarkdown(text: string): boolean {
  return Boolean(text.trim()) && !isUncommittedMarkdown(text);
}
