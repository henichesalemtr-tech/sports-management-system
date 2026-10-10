import { apiRoute } from '@/shared/api/route';
import { requirePermission } from '@/shared/permissions/guard';
import { athleteService } from '@/modules/athletes/service';
import { bulkDeleteAthletesSchema } from '@/modules/athletes/schema';

/** DELETE /api/v1/athletes/bulk-delete — حذف مرن لغاية 100 رياضيًا في الطلب الواحد. */
export const DELETE = apiRoute({
  body: bulkDeleteAthletesSchema,
  handler: async ({ user, body, requestId, ip, userAgent }) => {
    await requirePermission(user, 'athletes.delete');
    return { data: await athleteService.removeMany(body.items, { user, requestId, ip, userAgent }) };
  },
});
