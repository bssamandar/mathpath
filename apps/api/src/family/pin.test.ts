import { describe, expect, it } from 'vitest';
import { isTooSimplePin } from './pin';

describe('isTooSimplePin', () => {
  it.each(['0000', '1111', '1234', '4321', '123456', '987654', '1212', '121212', '123123'])(
    'refuses %s',
    (pin) => expect(isTooSimplePin(pin)).toBe(true),
  );

  it.each(['2580', '7391', '8642', '130719', '1123'])('accepts %s', (pin) =>
    expect(isTooSimplePin(pin)).toBe(false),
  );
});
