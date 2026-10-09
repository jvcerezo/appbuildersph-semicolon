/** 5052 -> "1:24:12"; 75 -> "0:01:15". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

let counter = 0;
export function newRequestId(): string {
  counter += 1;
  return `req-${Date.now().toString(36)}-${counter}`;
}
