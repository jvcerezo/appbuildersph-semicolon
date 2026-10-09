const BARS = [0.35, 0.7, 1, 0.7, 0.35];

export function ListeningAnimation() {
  return (
    <div className="listening" aria-hidden="true">
      <div className="listening__ring" />
      <div className="listening__bars">
        {BARS.map((scale, i) => (
          <div
            key={i}
            className="listening__bar"
            style={{ height: `${(64 * scale + 16) / 16}rem`, animationDelay: `${i * 0.18}s` }}
          />
        ))}
      </div>
    </div>
  );
}
