'use client';

import { useEffect, useId, useRef } from 'react';
import { COUNTRY_PREFIX, formatPhone, phoneDigits } from '../lib/phone';

/** Fixed +998 prefix, numeric keyboard, grouped as typed (UX S2). */
export function PhoneInput({
  label,
  hint,
  digits,
  onChange,
}: {
  label: string;
  hint?: string;
  digits: string;
  onChange(digits: string): void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="prefixed">
        <span aria-hidden="true">{COUNTRY_PREFIX}</span>
        <input
          id={id}
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          placeholder="90 123 45 67"
          aria-describedby={hint ? `${id}-hint` : undefined}
          value={formatPhone(digits)}
          onChange={(e) => onChange(phoneDigits(e.target.value))}
          required
        />
      </div>
      {hint && (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * The SMS code. One field rather than six boxes: Android and iOS fill a single
 * `one-time-code` field from the SMS reliably, and pasting just works; wide
 * letter spacing gives the look of separate boxes.
 */
export function CodeInput({
  label,
  value,
  length = 6,
  onChange,
  onComplete,
}: {
  label: string;
  value: string;
  length?: number;
  onChange(value: string): void;
  onComplete?(value: string): void;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        ref={ref}
        id={id}
        className="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={length}
        value={value}
        onChange={(e) => {
          const next = e.target.value.replace(/\D/g, '').slice(0, length);
          onChange(next);
          if (next.length === length) onComplete?.(next);
        }}
        required
      />
    </div>
  );
}

export function TextInput({
  label,
  hint,
  value,
  onChange,
  type = 'text',
  autoComplete,
  inputMode,
  maxLength,
  required = true,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange(value: string): void;
  type?: 'text' | 'password';
  autoComplete?: string;
  inputMode?: 'text' | 'numeric';
  maxLength?: number;
  required?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        aria-describedby={hint ? `${id}-hint` : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
      />
      {hint && (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
    </div>
  );
}
