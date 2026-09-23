'use client';

import type { BusinessTemplate } from '@shuttle-lite/core';

export function BusinessMetadataFields({
  template,
  values,
  onChange,
}: {
  template: BusinessTemplate;
  values: Record<string, string | number>;
  onChange: (values: Record<string, string | number>) => void;
}) {
  return (
    <>
      {template.fields.map((field) => (
        <label key={field.key}>
          {field.displayName}
          {field.type === 'enum' ? (
            <select
              value={values[field.key] ?? ''}
              onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}
            >
              <option value="">未選択</option>
              {field.options?.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={field.type === 'float' ? 'number' : field.type === 'date' ? 'date' : 'text'}
              step={field.type === 'float' ? 'any' : undefined}
              maxLength={field.type === 'string' ? 2000 : undefined}
              value={
                field.type === 'date'
                  ? String(values[field.key] ?? '').slice(0, 10)
                  : (values[field.key] ?? '')
              }
              onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}
            />
          )}
        </label>
      ))}
    </>
  );
}
