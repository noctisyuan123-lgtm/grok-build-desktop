const PIXELS = [
  '.........',
  '..#####..',
  '.##...##.',
  '##.......',
  '##..####.',
  '##....##.',
  '.##...##.',
  '..#####..',
  '.........',
];

// The same compact pixel geometry used by scripts/generate_icon.mjs. Keeping
// it as filled SVG cells makes the 17px settings mark crisp and ensures the
// in-app identity actually follows the Dock icon.
export function BrandGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 9 9" aria-hidden focusable="false">
      {PIXELS.flatMap((row, y) =>
        [...row].map((cell, x) =>
          cell === '#' ? (
            <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="currentColor" />
          ) : null,
        ),
      )}
    </svg>
  );
}
