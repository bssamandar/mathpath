/**
 * Passwords that meet the length rule but are guessed first by attackers.
 *
 * A short local list, so the most obvious choices are refused even when the
 * breached-password service cannot be reached. It includes patterns common in
 * Uzbekistan and Russian-speaking countries ("parol" means "password").
 * Compared in lower case.
 */
export const commonPasswords: ReadonlySet<string> = new Set([
  '1234567890',
  '0987654321',
  '12345678910',
  '1111111111',
  '0000000000',
  '1234512345',
  '1122334455',
  '123456789a',
  'a123456789',
  '123456789q',
  'q123456789',
  'qwertyuiop',
  'qwerty1234',
  'qwerty12345',
  'qwerty123456',
  '1q2w3e4r5t',
  '1qaz2wsx3edc',
  'zaq12wsxcde3',
  'asdfghjkl1',
  'password12',
  'password123',
  'password1234',
  'passw0rd123',
  'iloveyou12',
  'parol12345',
  'parol123456',
  'parolparol',
  'mathpath123',
  'mathpath2026',
  'uzbekistan',
  'uzbekistan1',
  'toshkent123',
  'tashkent123',
  'samarkand123',
  'ytrewq123456',
  'йцукенгшщз',
  'пароль12345',
]);
