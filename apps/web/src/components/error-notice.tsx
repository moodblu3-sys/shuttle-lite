import { errorPresentation } from '../lib/error-presentation';

export function ErrorNotice({
  category,
  message,
  state,
  title,
  action,
}: {
  category?: string | null;
  message?: string | null;
  state?: string;
  title?: string;
  action?: string;
}) {
  const presentation = errorPresentation(category, state);
  return (
    <div className="error" role="alert">
      <p>
        <strong>{title ?? presentation.title}</strong>
      </p>
      <p>{action ?? presentation.action}</p>
      {category || message ? (
        <details>
          <summary>技術情報</summary>
          {category ? <p className="mono small">{category}</p> : null}
          {message ? (
            <p className="small" style={{ overflowWrap: 'anywhere' }}>
              {message}
            </p>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
