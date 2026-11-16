/**
 * SMS texts. Short and in Uzbek (Latin) and Russian together, because the
 * user's language is not known before sign-up. Each part fits one GSM-7 or
 * UCS-2 segment as closely as practical to keep SMS costs down.
 */
export const smsMessages = {
  otpCode: (code: string): string =>
    `MathPath kodi: ${code}. Uni hech kimga bermang. / Kod: ${code}. Никому не сообщайте.`,
  confirmCode: (code: string): string =>
    `MathPath tasdiqlash kodi: ${code}. Uni hech kimga bermang. / Код подтверждения: ${code}.`,
  childPinLocked: (): string =>
    'MathPath: farzandingiz profiliga ko‘p marta noto‘g‘ri PIN kiritildi, profil vaqtincha bloklandi. / Профиль ребёнка временно заблокирован из-за неверных PIN.',
  alreadyRegistered: (): string =>
    'Bu raqam MathPath’da ro‘yxatdan o‘tgan. Kirish sahifasidan foydalaning. / Номер уже зарегистрирован, войдите в аккаунт.',
  accountLocked: (): string =>
    'MathPath: hisobingizga ko‘p marta noto‘g‘ri parol kiritildi. Siz bo‘lmasangiz, parolni almashtiring. / Много неверных паролей. Если это не вы, смените пароль.',
} as const;
