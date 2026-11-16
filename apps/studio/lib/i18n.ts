/**
 * Studio texts. Staff work in Uzbek for now, so there is one dictionary; the
 * typed shape is the same as in the web app, so Russian and English can be
 * added as files without touching the screens.
 */
export const uz = {
  'app.title': 'MathPath Studio',
  'nav.tree': 'Kontent',
  'nav.signOut': 'Chiqish',

  'login.title': 'Xodimlar uchun kirish',
  'login.phone': 'Telefon raqami',
  'login.phoneHint': '+998 bilan, masalan +998901234567',
  'login.password': 'Parol',
  'login.submit': 'Kirish',
  'login.notStaff': 'Studio faqat muallif, tekshiruvchi va adminlar uchun.',
  'mfa.title': 'Ikki bosqichli tasdiq',
  'mfa.enterCode': 'Autentifikator ilovasidagi 6 xonali kod',
  'mfa.verify': 'Tasdiqlash',
  'mfa.useRecovery': 'Zaxira kod bilan kirish',
  'mfa.recoveryCode': 'Zaxira kod',
  'mfa.enrolTitle': 'Autentifikator ilovasini ulang',
  'mfa.enrolSteps':
    'Google Authenticator, Microsoft Authenticator yoki shunga o‘xshash ilovada yangi hisob qo‘shing. Telefoningizda bo‘lsangiz, havolani bosing; aks holda kalitni qo‘lda kiriting.',
  'mfa.openApp': 'Ilovada ochish',
  'mfa.secret': 'Kalit',
  'mfa.recoveryTitle': 'Zaxira kodlarni saqlang',
  'mfa.recoveryText':
    'Telefoningiz yo‘qolsa, shu kodlar bilan kirasiz. Har biri bir marta ishlaydi. Ular boshqa ko‘rsatilmaydi.',
  'mfa.recoverySaved': 'Saqladim, davom etish',

  'tree.title': 'Kontent daraxti',
  'tree.empty': 'Hali kurslar yo‘q. Demo kontentni `pnpm db:seed` bilan yuklang.',
  'tree.noDraft': 'Versiya yo‘q',
  'tree.free': 'Bepul',
  'tree.untitled': 'Nomsiz mavzu',

  'status.draft': 'Qoralama',
  'status.in_review': 'Tekshiruvda',
  'status.changes_requested': 'O‘zgartirish so‘ralgan',
  'status.approved': 'Tasdiqlangan',
  'status.published': 'Nashr qilingan',
  'status.archived': 'Arxivda',

  'editor.versions': 'Versiyalar',
  'editor.version': '{n}-versiya',
  'editor.newDraft': 'Yangi qoralama',
  'editor.newDraftHint':
    'Nashr qilingan dars o‘zgarmaydi. Tahrir uchun undan nusxa olinib, yangi versiya ochiladi.',
  'editor.title': 'Sarlavha',
  'editor.summary': 'Qisqacha mazmun',
  'editor.steps': 'Dars qadamlari',
  'editor.addStep': 'Qadam qo‘shish',
  'editor.moveUp': 'Yuqoriga',
  'editor.moveDown': 'Pastga',
  'editor.remove': 'O‘chirish',
  'editor.save': 'Saqlash',
  'editor.saved': 'Saqlandi',
  'editor.unsaved': 'Saqlanmagan o‘zgarishlar bor',
  'editor.submit': 'Tekshiruvga yuborish',
  'editor.readOnly': 'Bu versiyani tahrirlab bo‘lmaydi ({status}).',
  'editor.preview': 'Ko‘rinishi',
  'editor.required': 'Majburiy',
  'editor.prompt': 'Topshiriq matni',
  'editor.activity': 'Interaktiv mashq turi',
  'editor.activityConfig': 'Sozlamalar (JSON)',
  'editor.minCorrect': 'Kamida to‘g‘ri javoblar',
  'editor.questionsLater': 'Savollar 6.4-bosqichda savol muharriri bilan qo‘shiladi.',

  'step.video': 'Video',
  'step.activity': 'Interaktiv mashq',
  'step.practice': 'Mashq',
  'step.mastery_test': 'Yakuniy test',
  'step.review': 'Takrorlash',

  'activity.drag_drop': 'Sudrab tashlash',
  'activity.number_line': 'Son o‘qi',
  'activity.fraction_model': 'Kasr modeli',
  'activity.step_solver': 'Bosqichma-bosqich yechish',

  'video.choose': 'Video tanlash (MP4)',
  'video.uploading': 'Yuklanmoqda: {percent}%',
  'video.processing': 'Video tayyorlanmoqda (bir necha daqiqa)…',
  'video.ready': 'Tayyor: {duration}, {renditions}',
  'video.failed': 'Video qabul qilinmadi: {reason}',
  'video.replace': 'Boshqa video',
  'video.subtitles': 'Subtitrlar (WebVTT)',
  'video.addSubtitle': '{locale} subtitr yuklash',
  'video.noVideo': 'Video tanlanmagan',

  'review.title': 'Tekshiruv',
  'review.approve': 'Tasdiqlash',
  'review.requestChanges': 'O‘zgartirish so‘rash',
  'review.comment': 'Izoh',
  'review.commentRequired': 'O‘zgartirish so‘rash uchun izoh yozing.',
  'review.ownWork': 'O‘z versiyangizni tekshira olmaysiz (to‘rt ko‘z qoidasi).',
  'review.history': 'Tekshiruv tarixi',
  'review.publish': 'Nashr qilish',
  'review.publishHint': 'Nashrdan keyin yangi o‘quvchilar shu versiyani ko‘radi.',

  'error.generic': 'Nimadir xato ketdi. Qayta urinib ko‘ring.',
  'error.offline': 'Internet aloqasi yo‘q.',
  'error.INVALID_CREDENTIALS': 'Telefon yoki parol noto‘g‘ri.',
  'error.MFA_CODE_INVALID': 'Kod noto‘g‘ri.',
  'error.TOO_MANY_REQUESTS': 'Juda ko‘p urinish. {minutes} daqiqadan keyin qayta urinib ko‘ring.',
  'error.VERSION_CHANGED': 'Bu versiyani boshqa kishi saqladi. Sahifani yangilang.',
  'error.VERSION_STATE_CONFLICT': 'Versiya holati o‘zgardi. Sahifani yangilang.',
  'error.DRAFT_EXISTS': 'Bu mavzuda ochiq versiya bor.',
  'error.CONTENT_INCOMPLETE': 'Ba’zi maydonlar to‘ldirilmagan.',
  'error.FOUR_EYES': 'O‘z versiyangizni tekshira olmaysiz.',
  'error.VALIDATION_FAILED': 'Ma’lumotlar noto‘g‘ri.',
  'error.UPLOAD_REJECTED': 'Fayl qabul qilinmadi.',
  'error.FORBIDDEN': 'Bu amal uchun huquqingiz yo‘q.',
  'error.MFA_REQUIRED': 'Avval ikki bosqichli tasdiqdan o‘ting.',
} as const;

export type MessageKey = keyof typeof uz;
export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/** Fills `{name}` placeholders; unknown placeholders stay visible so they get noticed. */
export const t: Translate = (key, params = {}) =>
  uz[key].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );

export function isMessageKey(key: string): key is MessageKey {
  return key in uz;
}
