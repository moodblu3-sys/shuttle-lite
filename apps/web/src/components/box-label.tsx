import Image from 'next/image';

/** Fixed UI labels keep their readable name while displaying the Box wordmark. */
export function BoxLabel({ children, inverse = false }: { children: string; inverse?: boolean }) {
  const index = children.indexOf('Box');
  if (index < 0) return children;
  return (
    <span className="box-label">
      {children.slice(0, index)}
      <span className="box-logo-text">Box</span>
      <Image
        className={`box-logo${inverse ? ' box-logo-inverse' : ''}`}
        src="/box-logo.png"
        width={1280}
        height={687}
        alt=""
        aria-hidden="true"
        unoptimized
      />
      {children.slice(index + 3)}
    </span>
  );
}
