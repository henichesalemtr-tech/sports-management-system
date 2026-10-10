import { prisma, type PrismaTransaction } from '@/shared/db/client';
import { writeAudit } from '@/shared/audit';
import { AppError, ErrorCode, businessRule, forbidden, notFound } from '@/shared/errors';
import type { Meta } from '@/shared/api/meta';
import { hasPermission, type AuthContext } from '@/shared/permissions/guard';
import { parseDateOnly, todayIn } from '@/shared/dates';
import { remaining, sumMinor, type MinorUnits } from '@/shared/money';
import { getSettings } from '@/modules/settings/service';
import { athleteRepository, type AthleteWithDetails, type DuplicateCandidateRow } from './repository';
import { detectAthleteDuplicates, type AthleteDuplicateMatch, type DuplicateCandidate } from './duplicates';
import { formatHasSequence, generateRegistrationNumber, nextSequence } from './registrationNumber';
import type { AthleteDuplicatesQuery, AthleteListQuery, CreateAthleteInput, UpdateAthleteInput } from './schema';

const ENTITY = 'Athlete';
const SENSITIVE_PERMISSION = 'athletes.view_sensitive';

type Db = typeof prisma | PrismaTransaction;

const versionConflictError = () =>
  new AppError(ErrorCode.VERSION_CONFLICT, 'تم تعديل السجل من مستخدم آخر، حدّث الصفحة وحاول مجددًا');

/** DTO عام للرياضي — الحقول الحساسة تظهر فقط لحامل athletes.view_sensitive (6.6). */
export type AthleteDto = Omit<AthleteWithDetails, 'scanCodeHash' | 'medicalNotes' | 'bloodType' | 'allergies'> & {
  medicalNotes?: string | null;
  bloodType?: string | null;
  allergies?: string | null;
};

function stripAthlete(a: AthleteWithDetails, canViewSensitive: boolean): AthleteDto {
  const { scanCodeHash: _scanCodeHash, medicalNotes, bloodType, allergies, ...rest } = a;
  void _scanCodeHash;
  return canViewSensitive ? { ...rest, medicalNotes, bloodType, allergies } : rest;
}

function hasSensitiveInput(input: Partial<CreateAthleteInput>): boolean {
  return input.medicalNotes !== undefined || input.bloodType !== undefined || input.allergies !== undefined;
}

function toCandidate(row: DuplicateCandidateRow): DuplicateCandidate {
  return {
    id: row.id,
    registrationNo: row.registrationNo,
    firstName: row.firstName,
    lastName: row.lastName,
    birthDate: row.birthDate.toISOString().slice(0, 10),
    phone: row.phone,
    parentPhones: row.parents.flatMap((p) => [p.parent.phone, p.parent.phone2]),
  };
}

const big = (v: MinorUnits): string => v.toString();

async function assertParentsExist(parentIds: string[], db: Db): Promise<void> {
  if (parentIds.length === 0) return;
  const count = await db.parent.count({ where: { id: { in: parentIds }, deletedAt: null } });
  if (count !== new Set(parentIds).size) throw notFound('أحد الأولياء المرتبطين');
}

export const athleteService = {
  async list(query: AthleteListQuery, user: AuthContext): Promise<{ items: AthleteDto[]; total: number }> {
    const canViewSensitive = await hasPermission(user, SENSITIVE_PERMISSION);
    const { items, total } = await athleteRepository.list(query);
    return { items: items.map((a) => stripAthlete(a, canViewSensitive)), total };
  },

  async getById(id: string, user: AuthContext, meta: Meta): Promise<AthleteDto> {
    const athlete = await athleteRepository.findById(id);
    if (!athlete) throw notFound('الرياضي');
    const canViewSensitive = await hasPermission(user, SENSITIVE_PERMISSION);
    if (canViewSensitive) {
      // وصول صريح لبيانات حساسة — يُسجَّل VIEW_SENSITIVE (6.6)
      await writeAudit({
        userId: user.userId,
        action: 'VIEW_SENSITIVE',
        entityType: ENTITY,
        entityId: id,
        requestId: meta.requestId,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
        metadata: { fields: ['medicalNotes', 'bloodType', 'allergies'] },
      });
    }
    return stripAthlete(athlete, canViewSensitive);
  },

  /** كشف التكرار (تحذير قابل للتجاوز) — نفس المنطق المستخدم عند الإنشاء. */
  async findDuplicates(query: AthleteDuplicatesQuery): Promise<AthleteDuplicateMatch[]> {
    const rows = await athleteRepository.findByNameParts(query.firstName, query.lastName, query.excludeId);
    const parentPhones = (query.parentPhones ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    return detectAthleteDuplicates(
      {
        firstName: query.firstName,
        lastName: query.lastName,
        birthDate: query.birthDate ?? null,
        phone: query.phone ?? null,
        parentPhones,
      },
      rows.map(toCandidate),
    );
  },

  async create(input: CreateAthleteInput, user: AuthContext, meta: Meta): Promise<AthleteDto> {
    const canViewSensitive = await hasPermission(user, SENSITIVE_PERMISSION);
    if (hasSensitiveInput(input) && !canViewSensitive) {
      throw forbidden('ليست لديك صلاحية إدخال الحقول الطبية الحساسة');
    }

    const settings = await getSettings();
    const today = todayIn(settings.timezone);
    const birthDate = parseDateOnly(input.birthDate);
    if (input.birthDate > today) throw businessRule('تاريخ الميلاد لا يمكن أن يكون في المستقبل');

    return prisma.$transaction(async (tx) => {
      // 1) كشف التكرار — تحذير قابل للتجاوز عبر overrideDuplicate
      const links = input.parents ?? [];
      await assertParentsExist(links.map((l) => l.parentId), tx);
      const linkedParents = links.length
        ? await tx.parent.findMany({ where: { id: { in: links.map((l) => l.parentId) } }, select: { phone: true, phone2: true } })
        : [];
      const nameRows = await athleteRepository.findByNameParts(input.firstName, input.lastName, undefined, tx);
      const matches = detectAthleteDuplicates(
        {
          firstName: input.firstName,
          lastName: input.lastName,
          birthDate: input.birthDate,
          phone: input.phone || null,
          parentPhones: linkedParents.flatMap((p) => [p.phone, p.phone2]),
        },
        nameRows.map(toCandidate),
      );
      if (matches.length > 0 && input.overrideDuplicate !== true) {
        throw new AppError(ErrorCode.DUPLICATE_RECORD, 'يوجد رياضيون محتملو التكرار — راجع القائمة أو أكّد التجاوز', {
          details: { matches },
        });
      }

      // 2) توليد رقم التسجيل حسب الصيغة المضبوطة (Settings-driven)
      const format = settings.athletesRegistrationFormat;
      const existingNumbers = await athleteRepository.findAllRegistrationNumbers(tx);
      const sequence = formatHasSequence(format) ? nextSequence(existingNumbers, format) : 1;
      const [yearPart, monthPart] = today.split('-').map(Number) as [number, number, number];
      let registrationNo: string;
      try {
        registrationNo = generateRegistrationNumber(format, {
          year: yearPart,
          month: monthPart,
          sequence,
          sportCode: input.sportId
            ? ((await tx.sport.findUnique({ where: { id: input.sportId }, select: { nameEn: true } }))?.nameEn ?? undefined)
            : undefined,
        });
      } catch (e) {
        throw businessRule(e instanceof Error ? e.message : 'تعذر توليد رقم التسجيل');
      }

      // 3) الإنشاء
      const { parents: parentLinks, overrideDuplicate: _override, ...fields } = input;
      void _override;
      const created = await athleteRepository.create(
        {
          ...fields,
          phone: fields.phone || null,
          birthDate,
          registrationDate: input.registrationDate ? parseDateOnly(input.registrationDate) : parseDateOnly(today),
          registrationNo,
          createdBy: meta.user.userId,
          updatedBy: meta.user.userId,
          parents: {
            create: (parentLinks ?? []).map((l) => ({
              parentId: l.parentId,
              relationship: l.relationship ?? null,
              isPrimary: l.isPrimary ?? false,
              isPayer: l.isPayer ?? false,
              isEmergency: l.isEmergency ?? false,
            })),
          },
        },
        tx,
      );

      // 4) Audit — لا تُدرج القيم الطبية الحساسة في السجل، فقط الإشارة لضبطها
      const sensitiveSet = (['medicalNotes', 'bloodType', 'allergies'] as const).filter(
        (k) => input[k] !== undefined && input[k] !== null,
      );
      await writeAudit(
        {
          userId: meta.user.userId,
          action: 'CREATE',
          entityType: ENTITY,
          entityId: created.id,
          requestId: meta.requestId,
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
          after: { ...stripAthlete(created, false), registrationNo },
          metadata: { duplicateOverridden: matches.length > 0, sensitiveFieldsSet: sensitiveSet },
        },
        tx,
      );
      return stripAthlete(created, canViewSensitive);
    });
  },

  async update(id: string, input: UpdateAthleteInput, user: AuthContext, meta: Meta): Promise<AthleteDto> {
    const canViewSensitive = await hasPermission(user, SENSITIVE_PERMISSION);
    if (hasSensitiveInput(input) && !canViewSensitive) {
      throw forbidden('ليست لديك صلاحية تعديل الحقول الطبية الحساسة');
    }

    return prisma.$transaction(async (tx) => {
      const current = await athleteRepository.findById(id, {}, tx);
      if (!current) throw notFound('الرياضي');

      const { version, parents: parentLinks, ...data } = input;
      if (parentLinks) await assertParentsExist(parentLinks.map((l) => l.parentId), tx);

      const count = await athleteRepository.updateWithVersion(
        id,
        version,
        {
          ...data,
          phone: data.phone === undefined ? undefined : data.phone || null,
          ...(data.birthDate ? { birthDate: parseDateOnly(data.birthDate) } : {}),
          ...(data.registrationDate ? { registrationDate: parseDateOnly(data.registrationDate) } : {}),
          updatedBy: meta.user.userId,
        },
        tx,
      );
      if (count === 0) throw versionConflictError();
      if (parentLinks) await athleteRepository.setParentLinks(id, parentLinks, tx);

      const after = await athleteRepository.findById(id, {}, tx);
      if (!after) throw notFound('الرياضي');
      await writeAudit(
        {
          userId: meta.user.userId,
          action: 'UPDATE',
          entityType: ENTITY,
          entityId: id,
          requestId: meta.requestId,
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
          before: stripAthlete(current, false),
          after: stripAthlete(after, false),
        },
        tx,
      );
      return stripAthlete(after, canViewSensitive);
    });
  },

  /** حذف مرن (Soft Delete) — يبقى السجل والتاريخ المالي. */
  async remove(id: string, version: number, meta: Meta): Promise<{ id: string }> {
    return prisma.$transaction(async (tx) => {
      const current = await athleteRepository.findById(id, {}, tx);
      if (!current) throw notFound('الرياضي');
      const count = await athleteRepository.softDelete(id, version, new Date(), meta.user.userId, tx);
      if (count === 0) throw versionConflictError();
      await writeAudit(
        {
          userId: meta.user.userId,
          action: 'DELETE',
          entityType: ENTITY,
          entityId: id,
          requestId: meta.requestId,
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
          before: { registrationNo: current.registrationNo, status: current.status },
        },
        tx,
      );
      return { id };
    });
  },

  /** حذف مرن متعدد — يُنفّذ بالتتابع حتى تبقى أخطاء version واضحة لكل سجل. */
  async removeMany(items: Array<{ id: string; version: number }>, meta: Meta): Promise<{ ids: string[] }> {
    const ids: string[] = [];
    for (const item of items) {
      const result = await athleteService.remove(item.id, item.version, meta);
      ids.push(result.id);
    }
    return { ids };
  },

  /** استعادة رياضي محذوف (يتطلب athletes.restore — يُفحص في المسار). */
  async restore(id: string, meta: Meta): Promise<{ id: string }> {
    return prisma.$transaction(async (tx) => {
      const current = await athleteRepository.findById(id, { includeDeleted: true }, tx);
      if (!current) throw notFound('الرياضي');
      if (!current.deletedAt) throw businessRule('الرياضي غير محذوف — لا حاجة للاستعادة');
      const count = await athleteRepository.restore(id, meta.user.userId, tx);
      if (count === 0) throw versionConflictError();
      await writeAudit(
        {
          userId: meta.user.userId,
          action: 'RESTORE',
          entityType: ENTITY,
          entityId: id,
          requestId: meta.requestId,
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
          metadata: { registrationNo: current.registrationNo },
        },
        tx,
      );
      return { id };
    });
  },

  /** الملف الشخصي الكامل: اشتراكات + مدفوعات + نسبة حضور + مجموعات + تقييمات + وثائق + خط زمني. */
  async profile(id: string, user: AuthContext, meta: Meta) {
    const found = await athleteRepository.findById(id);
    if (!found) throw notFound('الرياضي');
    const athlete = found;
    const canViewSensitive = await hasPermission(user, SENSITIVE_PERMISSION);
    if (canViewSensitive) {
      await writeAudit({
        userId: user.userId,
        action: 'VIEW_SENSITIVE',
        entityType: ENTITY,
        entityId: id,
        requestId: meta.requestId,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
        metadata: { view: 'profile' },
      });
    }

    const [subscriptions, payments, attendance, memberships, evaluations, documents, timeline] = await Promise.all([
      athleteRepository.findSubscriptions(id),
      athleteRepository.findPayments(id),
      athleteRepository.countAttendanceByStatus(id),
      athleteRepository.findGroupMemberships(id),
      athleteRepository.findEvaluations(id),
      athleteRepository.findDocuments(id),
      athleteRepository.findTimeline(id),
    ]);
    const paidBySubscription = await athleteRepository.sumNonVoidedPaymentsBySubscription(
      subscriptions.map((s) => s.id),
    );

    // المال BigInt — يُحوَّل لنص في الـ DTO (JSON لا يدعم BigInt)
    const subscriptionDtos = subscriptions.map((s) => {
      const paid = paidBySubscription[s.id] ?? 0n;
      const due = remaining(s.netAmount, paid);
      return {
        id: s.id,
        status: s.status,
        startDate: s.startDate,
        endDate: s.endDate,
        dueDate: s.dueDate,
        typeName: s.subscriptionType.name,
        typeKind: s.subscriptionType.kind,
        groupName: s.group?.name ?? null,
        price: big(s.price),
        netAmount: big(s.netAmount),
        paidAmount: big(paid),
        remainingAmount: big(due),
        sessionsTotal: s.sessionsTotal,
        sessionsUsed: s.sessionsUsed,
      };
    });
    const totalDue = sumMinor(
      subscriptions.map((s) => remaining(s.netAmount, paidBySubscription[s.id] ?? 0n)),
    );

    const totalAttendance = attendance.PRESENT + attendance.ABSENT + attendance.LATE + attendance.EXCUSED;
    const attendanceRate =
      totalAttendance === 0
        ? null
        : Math.round(((attendance.PRESENT + attendance.LATE) / totalAttendance) * 1000) / 10;

    return {
      athlete: stripAthlete(athlete, canViewSensitive),
      subscriptions: subscriptionDtos,
      payments: payments.map((p) => ({
        id: p.id,
        transactionNo: p.transactionNo,
        amount: big(p.amount),
        netAmount: big(p.netAmount),
        refundedAmount: big(p.refundedAmount),
        paymentDate: p.paymentDate,
        method: p.paymentMethod.name,
        status: p.status,
        subscriptionId: p.subscriptionId,
      })),
      finances: {
        totalNet: big(sumMinor(subscriptions.map((s) => s.netAmount))),
        totalPaid: big(sumMinor(payments.filter((p) => p.status === 'COMPLETED' && !p.voidedAt).map((p) => p.netAmount))),
        totalDue: big(totalDue),
      },
      attendance: { ...attendance, total: totalAttendance, ratePercent: attendanceRate },
      groups: memberships.map((m) => ({
        id: m.group.id,
        name: m.group.name,
        code: m.group.code,
        sportName: m.group.sport.name,
        coachName: m.group.coach ? `${m.group.coach.firstName} ${m.group.coach.lastName}` : null,
        joinedAt: m.joinedAt,
        leftAt: m.leftAt,
        isActive: m.leftAt === null,
      })),
      evaluations: evaluations.map((e) => ({
        id: e.id,
        templateName: e.template.name,
        coachName: `${e.coach.firstName} ${e.coach.lastName}`,
        evaluationDate: e.evaluationDate,
        scores: safeJsonParse(e.scores),
        notes: e.notes,
      })),
      documents: documents.map((d) => ({
        id: d.id,
        typeName: d.documentType.name,
        originalName: d.originalName,
        expiryDate: d.expiryDate,
        status: d.status,
        createdAt: d.createdAt,
      })),
      timeline: timeline.map((t) => ({
        id: t.id,
        action: t.action,
        userId: t.userId,
        requestId: t.requestId,
        metadata: safeJsonParse(t.metadata),
        createdAt: t.createdAt,
      })),
    };
  },
};

function safeJsonParse(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
