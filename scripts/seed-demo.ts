/**
 * Seed تجريبي للتطوير فقط — بيانات واقعية تمر عبر طبقة الخدمات (Service Layer)
 * لضمان ممارسة نفس قواعد العمل والتدقيق (Audit) الموجودة في الإنتاج.
 *
 * ⛔ يرفض العمل عندما NODE_ENV=production.
 *
 * المتطلبات:
 *  - تشغيل `npm run seed` أولًا (طرق الدفع/فئات المصاريف/الفئات العمرية/الإعدادات).
 *  - قاعدة بيانات PostgreSQL مطبَّقة عليها الهجرة + prisma/raw-constraints.sql.
 *
 * ينشئ: مدير تجريبي، أنشطة، قاعة، مدربَين، مجموعتين، أولياء، 40 رياضيًا (20 أصاغر و20 أكابر)،
 * أنواع اشتراك (شهري/حصص)، اشتراكات (أحدها بخصم 10%)، دفعات بأرقام Idempotency،
 * حصص تدريب لـ 7 أيام، حضور جماعي لحصة اليوم، ومصروفين.
 * يضيف 40 رياضيًا: 20 أصاغر و20 أكابر.
 *
 * التشغيل: npm run seed:demo
 * لم يُشغَّل هذا السكربت في بيئة التوثيق (لا يتوفر node/npm/postgres هنا) —
 * انظر docs/PROGRESS.md.
 */
import './load-env';

if (process.env.NODE_ENV === 'production') {
  console.error(
    '[seed-demo] مرفوض: NODE_ENV=production. هذا السكربت للتطوير فقط ويُنشئ مستخدمًا بكلمة مرور معروفة.',
  );
  process.exit(1);
}

import { prisma } from '@/shared/db/client';
import { hashPassword } from '@/shared/auth/password';
import type { AuthContext } from '@/shared/permissions/guard';
import type { Meta } from '@/shared/api/meta';
import { sportService } from '@/modules/sports/service';
import { ageCategoryService } from '@/modules/age-categories/service';
import { venueService } from '@/modules/venues/service';
import { coachService } from '@/modules/coaches/service';
import { groupService } from '@/modules/groups/service';
import { parentService } from '@/modules/parents/service';
import { athleteService } from '@/modules/athletes/service';
import { subscriptionTypeService } from '@/modules/subscription-types/service';
import { subscriptionService } from '@/modules/subscriptions/service';
import { paymentService } from '@/modules/payments/service';
import { sessionService } from '@/modules/sessions/service';
import { attendanceService } from '@/modules/attendance/service';
import { expenseService, expenseCategoryService } from '@/modules/expenses/service';

const DEMO_ADMIN_EMAIL = 'admin@demo.test';
const DEMO_ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? 'Demo@12345';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function plusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function birthDateForAge(age: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - age);
  // يوم ميلاد ثابت منتصف السنة لتجنب مشاكل الحدود
  d.setUTCMonth(5, 15);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  // ---------- حارس التكرار ----------
  const existingAdmin = await prisma.user.findUnique({ where: { email: DEMO_ADMIN_EMAIL } });
  if (existingAdmin && process.env.FORCE_DEMO !== '1') {
    console.log(
      `[seed-demo] البيانات التجريبية موجودة مسبقًا (${DEMO_ADMIN_EMAIL}). ` +
        'لإعادة التشغيل اضبط FORCE_DEMO=1 (ستُنشأ بيانات إضافية).',
    );
    return;
  }

  // ---------- مستخدم تجريبي (يُنشأ مباشرة — نقطة الإقلاع الوحيدة خارج الخدمات) ----------
  console.warn(
    '[seed-demo] تحذير: سيُنشأ مستخدم تجريبي بكلمة مرور معروفة — للتطوير فقط، ممنوع في الإنتاج.',
  );
  let admin = existingAdmin;
  if (!admin) {
    admin = await prisma.user.create({
      data: {
        email: DEMO_ADMIN_EMAIL,
        username: 'demo_admin',
        fullName: 'المدير التجريبي',
        passwordHash: await hashPassword(DEMO_ADMIN_PASSWORD),
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
      },
    });
  }
  const user: AuthContext = {
    userId: admin.id,
    role: admin.role,
    email: admin.email,
    fullName: admin.fullName,
    linkedCoachId: null,
  };
  const meta: Meta = {
    user,
    requestId: 'seed-demo',
    ip: '127.0.0.1',
    userAgent: 'seed-demo-script',
  };

  // ---------- الفئات العمرية (من seed المرجعي) ----------
  const ageCats = await ageCategoryService.list({ page: 1, pageSize: 50 });
  if (ageCats.total === 0) {
    throw new Error('[seed-demo] لا توجد فئات عمرية — شغّل `npm run seed` أولًا.');
  }
  const minors =
    ageCats.items.find((c) => c.name === 'أصاغر') ??
    ageCats.items.find((c) => c.minAge !== null && c.minAge <= 11 && (c.maxAge ?? 99) >= 11);
  const seniors =
    ageCats.items.find((c) => c.name === 'أكابر') ?? ageCats.items.find((c) => c.kind === 'SENIOR');
  if (!minors || !seniors)
    throw new Error('[seed-demo] يجب توفر فئتي «أصاغر» و«أكابر» — شغّل `npm run seed` أولًا.');

  // ---------- الأنشطة ----------
  const football = await sportService.create(
    { name: 'كرة القدم (تجريبي)', nameEn: 'Football (Demo)', color: '#16a34a', sortOrder: 0 },
    meta,
  );
  const judo = await sportService.create(
    { name: 'الجيدو (تجريبي)', nameEn: 'Judo (Demo)', color: '#2563eb', sortOrder: 1 },
    meta,
  );
  console.log(`[seed-demo] أنشطة: ${football.name}, ${judo.name}`);

  // ---------- القاعة والمدربون ----------
  const venue = await venueService.create(
    { name: 'القاعة متعددة الرياضات (تجريبية)', type: 'HALL', capacity: 200, status: 'AVAILABLE' },
    meta,
  );
  const coach1 = await coachService.create(
    {
      firstName: 'محمد',
      lastName: 'بن عيسى',
      phone: '0550000001',
      specialization: 'كرة القدم',
      sportIds: [football.id],
    },
    meta,
  );
  const coach2 = await coachService.create(
    {
      firstName: 'سمير',
      lastName: 'قاسمي',
      phone: '0550000002',
      specialization: 'الجيدو',
      sportIds: [judo.id],
    },
    meta,
  );

  // ---------- المجموعات ----------
  const group1 = await groupService.create(
    {
      name: 'أصاغر كرة القدم (تجريبية)',
      code: 'DEMO-FOOT-U12',
      sportId: football.id,
      ageCategoryId: minors.id,
      coachId: coach1.id,
      venueId: venue.id,
      maxCapacity: 20,
      trainingDays: ['SAT', 'MON', 'WED'],
      startTime: '17:00',
      endTime: '18:30',
    },
    meta,
  );
  const group2 = await groupService.create(
    {
      name: 'الجيدو أكابر (تجريبية)',
      code: 'DEMO-JUDO-SR',
      sportId: judo.id,
      ageCategoryId: seniors.id,
      coachId: coach2.id,
      venueId: null,
      maxCapacity: 25,
      trainingDays: ['SUN', 'TUE'],
      startTime: '19:00',
      endTime: '20:30',
    },
    meta,
  );
  console.log(`[seed-demo] مجموعات: ${group1.name}, ${group2.name}`);

  // ---------- الأولياء والرياضيون ----------
  const father = await parentService.create(
    { firstName: 'عبد الرحمن', lastName: 'حمداوي', phone: '0661111111', relationship: 'الأب' },
    meta,
  );
  const mother = await parentService.create(
    { firstName: 'فاطمة', lastName: 'زروقي', phone: '0662222222', relationship: 'الأم' },
    meta,
  );
  const guardian = await parentService.create(
    { firstName: 'كريم', lastName: 'بلقاسم', phone: '0663333333', relationship: 'الوصي' },
    meta,
  );

  const athleteNames: Array<[string, string, 'MALE' | 'FEMALE', number]> = [
    // 20 رياضيًا في فئة الأصاغر (10–12 سنة)
    ['ياسين', 'حمداوي', 'MALE', 10],
    ['أمينة', 'حمداوي', 'FEMALE', 10],
    ['أيوب', 'زروقي', 'MALE', 11],
    ['مريم', 'بلقاسم', 'FEMALE', 11],
    ['إسلام', 'قاسمي', 'MALE', 12],
    ['ريان', 'بوعلام', 'MALE', 10],
    ['ليناء', 'سعاد', 'FEMALE', 12],
    ['نور', 'عمراني', 'FEMALE', 11],
    ['حمزة', 'مراد', 'MALE', 12],
    ['سارة', 'بن عمر', 'FEMALE', 10],
    ['أنس', 'شريف', 'MALE', 11],
    ['جنى', 'لعريبي', 'FEMALE', 12],
    ['وليد', 'صالح', 'MALE', 10],
    ['رؤى', 'منصوري', 'FEMALE', 11],
    ['بلال', 'حسني', 'MALE', 12],
    ['فرح', 'بوزيد', 'FEMALE', 10],
    ['معاذ', 'خالد', 'MALE', 11],
    ['تالا', 'قريشي', 'FEMALE', 12],
    ['سليم', 'داودي', 'MALE', 10],
    ['شيماء', 'رحماني', 'FEMALE', 11],
    // 20 رياضيًا في فئة الأكابر (20–35 سنة)
    ['مهدي', 'عمراني', 'MALE', 20],
    ['خالد', 'بن عيسى', 'MALE', 22],
    ['عبد الرحمان', 'قاسمي', 'MALE', 24],
    ['فاطمة', 'زروقي', 'FEMALE', 21],
    ['سارة', 'حمودي', 'FEMALE', 23],
    ['يوسف', 'بلحاج', 'MALE', 25],
    ['إيمان', 'مرابط', 'FEMALE', 26],
    ['مراد', 'بوعلام', 'MALE', 28],
    ['نسرين', 'علاوي', 'FEMALE', 27],
    ['رياض', 'سالمي', 'MALE', 30],
    ['حورية', 'بن داود', 'FEMALE', 29],
    ['كريم', 'شريف', 'MALE', 31],
    ['أسماء', 'منصوري', 'FEMALE', 32],
    ['طارق', 'لعريبي', 'MALE', 33],
    ['سميرة', 'حسني', 'FEMALE', 34],
    ['نبيل', 'بوزيد', 'MALE', 35],
    ['ملاك', 'رحماني', 'FEMALE', 22],
    ['وليد', 'خالد', 'MALE', 24],
    ['هدى', 'قريشي', 'FEMALE', 26],
    ['أيمن', 'داودي', 'MALE', 28],
  ];
  if (
    athleteNames.length !== 40 ||
    athleteNames.slice(0, 20).some(([, , , age]) => age >= 18) ||
    athleteNames.slice(20).some(([, , , age]) => age < 18)
  ) {
    throw new Error('[seed-demo] بيانات العرض يجب أن تحتوي 20 أصاغر و20 أكابر.');
  }
  const parentIds = [father.id, mother.id, guardian.id];
  const athletes = [];
  for (let i = 0; i < athleteNames.length; i++) {
    const [firstName, lastName, gender, age] = athleteNames[i] as [
      string,
      string,
      'MALE' | 'FEMALE',
      number,
    ];
    const created = await athleteService.create(
      {
        firstName,
        lastName,
        gender,
        birthDate: birthDateForAge(age),
        sportId: age >= 18 ? judo.id : football.id,
        ageCategoryId: age >= 18 ? seniors.id : minors.id,
        parents: [
          {
            parentId: parentIds[i % parentIds.length] as string,
            relationship: i % 3 === 0 ? 'الأب' : i % 3 === 1 ? 'الأم' : 'الوصي',
            isPrimary: true,
            isPayer: true,
            isEmergency: false,
          },
        ],
        overrideDuplicate: true,
      },
      user,
      meta,
    );
    athletes.push(created);
  }
  console.log(`[seed-demo] رياضيون: ${athletes.length} (أصاغر: 20، أكابر: 20)`);

  // ---------- أنواع الاشتراك ----------
  const monthlyType = await subscriptionTypeService.create(
    {
      name: 'اشتراك شهري (تجريبي)',
      kind: 'MONTHLY',
      sportId: null,
      defaultPrice: '2000.00',
      durationDays: 30,
      allowPriceEdit: true,
    },
    meta,
  );
  const sessionsType = await subscriptionTypeService.create(
    {
      name: 'بطاقة 10 حصص (تجريبية)',
      kind: 'SESSIONS',
      sportId: judo.id,
      defaultPrice: '1500.00',
      durationDays: null,
      sessionsTotal: 10,
      allowPriceEdit: false,
    },
    meta,
  );

  // ---------- الاشتراكات ----------
  const cashMethod = await prisma.paymentMethod.findFirst({ where: { name: 'نقدًا' } });
  if (!cashMethod)
    throw new Error('[seed-demo] طريقة الدفع «نقدًا» غير موجودة — شغّل `npm run seed` أولًا.');

  const subscriptions = [];
  for (let i = 0; i < athletes.length; i++) {
    const athlete = athletes[i]!;
    const isJudoka = athlete.sportId === judo.id;
    const sub = await subscriptionService.create(
      {
        athleteId: athlete.id,
        sportId: athlete.sportId ?? null,
        groupId: isJudoka ? group2.id : group1.id,
        subscriptionTypeId: isJudoka ? sessionsType.id : monthlyType.id,
        startDate: today(),
        // نوع الحصص بلا مدة ⇒ تاريخ النهاية إلزامي (subscriptions/service.create)
        ...(isJudoka ? { endDate: plusDays(90) } : {}),
        sessionsTotal: isJudoka ? 10 : null,
        // خصم 10% لأول رياضي فقط (يتطلب سببًا إلزاميًا — 7.9)
        ...(i === 0
          ? { discount: { kind: 'PERCENT' as const, value: '10', reason: 'خصم افتتاحي تجريبي' } }
          : {}),
      },
      meta,
    );
    subscriptions.push({ athlete, sub, isJudoka });
  }
  console.log(`[seed-demo] اشتراكات: ${subscriptions.length}`);

  // ---------- الدفعات (مع Idempotency keys — إعادة التشغيل لا تكرر الدفع) ----------
  let paymentsCount = 0;
  for (let i = 0; i < subscriptions.length; i++) {
    const { athlete, sub } = subscriptions[i]!;
    const netMajor = Number(sub.netAmount) / 100; // للعرض في السجل فقط
    const firstInstallment = (Math.floor(netMajor / 2) || 1).toFixed(2);
    await paymentService.create(
      {
        athleteId: athlete.id,
        subscriptionId: sub.id,
        amount: firstInstallment,
        paymentMethodId: cashMethod.id,
        paymentDate: today(),
        notes: 'قسط أول (تجريبي)',
      },
      meta,
      `demo-pay-${i}-1`,
    );
    paymentsCount++;
    if (i % 2 === 0) {
      // قسط ثانٍ لنصف الرياضيين
      await paymentService.create(
        {
          athleteId: athlete.id,
          subscriptionId: sub.id,
          amount: firstInstallment,
          paymentMethodId: cashMethod.id,
          paymentDate: today(),
          notes: 'قسط ثانٍ (تجريبي)',
        },
        meta,
        `demo-pay-${i}-2`,
      );
      paymentsCount++;
    }
  }
  console.log(`[seed-demo] دفعات: ${paymentsCount}`);

  // ---------- الحصص ----------
  let sessionsCount = 0;
  for (let day = 0; day < 7; day++) {
    await sessionService.create(
      {
        type: 'TRAINING',
        title: `حصة تدريبية ${day + 1} (تجريبية)`,
        sportId: football.id,
        groupId: group1.id,
        coachId: coach1.id,
        venueId: venue.id,
        sessionDate: plusDays(day),
        startTime: '17:00',
        endTime: '18:30',
      },
      meta,
    );
    sessionsCount++;
  }
  // حصة اليوم لمجموعة الجيدو (وقت مختلف لتجنب تعارض القاعة)
  const judoToday = await sessionService.create(
    {
      type: 'TRAINING',
      title: 'حصة جيدو اليوم (تجريبية)',
      sportId: judo.id,
      groupId: group2.id,
      coachId: coach2.id,
      venueId: null,
      sessionDate: today(),
      startTime: '19:00',
      endTime: '20:30',
    },
    meta,
  );
  sessionsCount++;

  // ---------- حضور جماعي لحصة اليوم ----------
  const todaySession = await prisma.trainingSession.findFirst({
    where: { groupId: group1.id, deletedAt: null, sessionDate: { gte: new Date(today()) } },
    orderBy: { sessionDate: 'asc' },
  });
  if (todaySession) {
    const result = await attendanceService.bulk(
      { sessionId: todaySession.id, markAllPresent: true, entries: [], method: 'BULK' },
      meta,
    );
    console.log(
      `[seed-demo] حضور جماعي: created=${result.created} skipped=${result.skipped.length}`,
    );
  }
  void judoToday;
  console.log(`[seed-demo] حصص تدريبية: ${sessionsCount}`);

  // ---------- المصاريف ----------
  const categories = await expenseCategoryService.list();
  if (categories.length > 0) {
    await expenseService.create(
      {
        amount: '5000.00',
        categoryId: categories[0]!.id,
        expenseDate: today(),
        description: 'شراء كرات ومعدات تدريب (تجريبي)',
        beneficiary: 'مورد المعدات الرياضي',
      },
      meta,
    );
    await expenseService.create(
      {
        amount: '12000.00',
        categoryId: categories[0]!.id,
        expenseDate: today(),
        description: 'فاتورة ماء وكهرباء للقاعة (تجريبية)',
        beneficiary: 'شركة التوزيع',
      },
      meta,
    );
    console.log('[seed-demo] مصاريف: 2');
  }

  console.log('');
  console.log('==================== ملخص البيانات التجريبية ====================');
  console.log(`المستخدم التجريبي: ${DEMO_ADMIN_EMAIL} / ${DEMO_ADMIN_PASSWORD}`);
  console.log('⚠️ للتطوير فقط — ممنوع استخدام هذا السكربت أو هذا الحساب في الإنتاج.');
  console.log('=================================================================');
}

main()
  .catch((e) => {
    console.error('[seed-demo] فشل:', e instanceof Error ? (e.stack ?? e.message) : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
