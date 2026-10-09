/**
 * The mark: sound waves becoming lines of text inside a speech bubble (hearing, then understanding).
 * Colors come from the theme (`--logo-*` in styles.css), so it turns black and white in high contrast.
 */
export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg
      className="logo"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path
        className="logo__bubble"
        d="M18 6h28a12 12 0 0 1 12 12v18a12 12 0 0 1-12 12H30l-12 10v-10a12 12 0 0 1-12-12V18A12 12 0 0 1 18 6z"
      />
      <path className="logo__wave" d="M15 23v8M20.5 17v20M26 21v12" />
      <path className="logo__text" d="M33 20h15M33 27h15M33 34h9" />
    </svg>
  );
}
