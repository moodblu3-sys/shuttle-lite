export function ShuttleBrand({ showName = true }: { showName?: boolean }) {
  return (
    <>
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <path d="M3 27 32 4c3-2 5 0 4 4l-7 27c-1 3-4 4-5 1l-6-12z" fill="#2467f4" />
        <path d="m3 27 15-3L32 8 13 29z" fill="#83b4ff" />
        <path d="m18 24 6 12-1-18z" fill="#1752cf" />
      </svg>
      {showName ? 'Shuttle Lite' : null}
    </>
  );
}
