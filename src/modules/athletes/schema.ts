import { z } from 'zod';
import { listQuerySchema } from '@/shared/api/query';
import { dateOnlySchema, emailSchema, phoneSchema, uuidSchema, versionSchema } from '@/shared/validation/common';

export const genderSchema = z.enum(['MALE', 'FEMALE']);

export const athleteStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'WITHDRAWN', 'BLOCKED']);

export const bloodTypeSchema = z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']);

/** ربط ولي برياضي (AthleteParent) مع أدوار العلاقة. */
export const athleteParentLinkSchema = z.object({
  parentId: uuidSchema,
  relationship: z.string().trim().max(50, 'صلة القرابة طويلة جدًا').optional(),
  isPrimary: z.boolean().optional(),
  isPayer: z.boolean().optional(),
  isEmergency: z.boolean().optional(),
});

const nameField = (label: string) =>
  z.string().trim().min(2, `${label} قصير جدًا`).max(80, `${label} طويل جدًا`);

export const createAthleteSchema = z.object({
  firstName: nameField('الاسم'),
  lastName: nameField('اللقب'),
  gender: genderSchema.default('MALE'),
  birthDate: dateOnlySchema,
  phone: phoneSchema.optional().or(z.literal('')).optional(),
  email: emailSchema.optional(),
  address: z.string().trim().max(500).optional(),
  sportId: uuidSchema.nullable().optional(),
  ageCategoryId: uuidSchema.nullable().optional(),
  registrationDate: dateOnlySchema.optional(),
  status: athleteStatusSchema.optional(),
  notes: z.string().trim().max(5000).optional(),
  additionalInfo: z.string().trim().max(5000).optional(),
  emergencyName: z.string().trim().max(150).optional(),
  emergencyPhone: phoneSchema.optional(),
  // حقول حساسة — تتطلب athletes.view_sensitive (6.6)
  medicalNotes: z.string().trim().max(5000).nullable().optional(),
  bloodType: bloodTypeSchema.nullable().optional(),
  allergies: z.string().trim().max(2000).nullable().optional(),
  imageConsent: z.boolean().optional(),
  // روابط الأولياء
  parents: z.array(athleteParentLinkSchema).max(6, 'عدد الأولياء كبير جدًا').optional(),
  /** تجاوز تحذير التكرار (إنشاء رغم وجود تطابق). */
  overrideDuplicate: z.boolean().optional(),
});

export const updateAthleteSchema = createAthleteSchema
  .omit({ overrideDuplicate: true })
  .partial()
  .extend({ version: versionSchema });

export const athleteParamsSchema = z.object({ id: uuidSchema });

export const deleteAthleteBodySchema = z.object({ version: versionSchema });
export const bulkDeleteAthletesSchema = z.object({
  items: z.array(z.object({ id: uuidSchema, version: versionSchema })).min(1).max(100),
});

export const restoreAthleteBodySchema = z.object({ version: versionSchema.optional() });

export const athleteListQuerySchema = listQuerySchema.extend({
  status: athleteStatusSchema.optional(),
  sportId: uuidSchema.optional(),
  ageCategoryId: uuidSchema.optional(),
  gender: genderSchema.optional(),
  groupId: uuidSchema.optional(),
  includeDeleted: z.enum(['true', 'false']).optional(),
});

export const athleteDuplicatesQuerySchema = z.object({
  firstName: nameField('الاسم'),
  lastName: nameField('اللقب'),
  birthDate: dateOnlySchema.optional(),
  phone: phoneSchema.optional(),
  /** هواتف الأولياء مفصولة بفاصلة. */
  parentPhones: z.string().trim().max(300).optional(),
  excludeId: uuidSchema.optional(),
});

export type CreateAthleteInput = z.infer<typeof createAthleteSchema>;
export type UpdateAthleteInput = z.infer<typeof updateAthleteSchema>;
export type AthleteListQuery = z.infer<typeof athleteListQuerySchema>;
export type AthleteDuplicatesQuery = z.infer<typeof athleteDuplicatesQuerySchema>;
export type AthleteParentLink = z.infer<typeof athleteParentLinkSchema>;
export type BulkDeleteAthletesInput = z.infer<typeof bulkDeleteAthletesSchema>;
