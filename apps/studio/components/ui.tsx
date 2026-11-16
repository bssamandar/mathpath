'use client';

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';

export function Button({
  variant = 'primary',
  busy = false,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      className={`button ${variant} ${props.className ?? ''}`}
      disabled={busy || props.disabled}
      aria-busy={busy}
    >
      {children}
    </button>
  );
}

/** An error announced to screen readers as soon as it appears. */
export function ErrorText({ message }: { message: string | null | undefined }) {
  return (
    <p className="error" role="alert" aria-live="assertive">
      {message ?? ''}
    </p>
  );
}

/** A labelled text input; the hint and error are tied to it for screen readers. */
export function Field({
  label,
  hint,
  error,
  multiline = false,
  value,
  onChange,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
  label: string;
  hint?: string;
  error?: string;
  multiline?: boolean;
  value: string;
  onChange(value: string): void;
}) {
  const id = useId();
  const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ');
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea
          id={id}
          value={value}
          rows={3}
          maxLength={4000}
          aria-invalid={Boolean(error)}
          aria-describedby={described || undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          {...props}
          value={value}
          aria-invalid={Boolean(error)}
          aria-describedby={described || undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {hint && (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
