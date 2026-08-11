const LONG_TEXT_CHAR_THRESHOLD = 800;
const LONG_TEXT_LINE_THRESHOLD = 10;

export function isLongUserText(text: string): boolean {
  return (
    text.length >= LONG_TEXT_CHAR_THRESHOLD ||
    text.split(/\r?\n/).length >= LONG_TEXT_LINE_THRESHOLD
  );
}
