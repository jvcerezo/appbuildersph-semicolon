/**
 * Three dots that pulse in turn while the AI works. Decorative: the words next to it ("Thinking…")
 * carry the meaning, so it stays hidden from screen readers and stands still under reduced motion.
 */
export function ThinkingDots({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <span className={`dots dots--${size}`} aria-hidden="true">
      <span className="dots__dot" />
      <span className="dots__dot" />
      <span className="dots__dot" />
    </span>
  );
}
