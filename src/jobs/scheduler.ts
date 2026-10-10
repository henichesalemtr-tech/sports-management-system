/**
 * مجدول داخل عملية الخادم (بديل تشغيل عامل منفصل): ينفّذ مهام التنبيهات دورياً.
 * الآلية: setInterval في Node بعد إقلاع Next من src/instrumentation.ts.
 *
 * لماذا هو آمن للتكرار والتوازي؟
 * - كل تشغيل يحاول حجز JobRun.lockKey (فريد) ⇒ التشغيل المتزامن يُتخطّى SKIPPED.
 * - الإشعارات نفسها Idempotent بقيد Notification.dedupeKey الفريد.
 *
 * عدة عمليات/Workers لنفس القاعدة آمنة للسبب نفسه.
 */
import { runInProcessJobs } from './in-process';

/**
 * المهام التي تُشغَّل داخل العملية: التنبيهات المالية/الاشتراكات والوثائق.
 * استُثنيت backup (تكتب ملفات وتستهلك pg_dump) وreconcile (تصحيح جماعي أثقل) —
 * تبقى للعامل/CRON المخصص.
 */

// حارس عبر globalThis: في وضع التطوير تُعاد تحميل الوحدات كثيرًا، والمؤقت يجب أن يُنشأ مرة واحدة.
const GUARD = Symbol.for('app.inProcessJobsStarted');
type GlobalWithGuard = typeof globalThis & { [GUARD]?: boolean };

export function startInProcessJobs(intervalMinutes: number): void {
  const g = globalThis as GlobalWithGuard;
  if (g[GUARD]) return;
  g[GUARD] = true;

  let running = false;
  const tick = async () => {
    // تراكُم الدورات غير مرغوب: إذا كانت السابقة لم تنتهِ نتخطى هذه.
    if (running) return;
    running = true;
    try {
      const { results } = await runInProcessJobs();
      for (const [name, outcome] of Object.entries(results)) {
        if (outcome.status !== 'SUCCESS') continue;
        if (outcome.itemsProcessed > 0) {
          console.log(`[jobs] ${name}: ${outcome.itemsProcessed} عنصر ${outcome.message ?? ''}`.trimEnd());
        }
      }
    } catch (e) {
      // لا تُسقط الخادم بسبب دورة مهام — الخطأ transient غالبًا (قاعدة كمونة).
      console.warn('[jobs] دورة فاشلة:', e instanceof Error ? e.message : String(e));
    } finally {
      running = false;
    }
  };

  const minutes = Math.max(1, intervalMinutes);
  // Unref حتى لا يمنع المؤقّت إغلاق العملية في الاختبارات/السكربتات.
  const timer = setInterval(tick, minutes * 60_000);
  timer.unref?.();
  // دورة أولى بعد إقلاع قصير: التنبيهات يجب ألا تنتظر أول فترة كاملة.
  const first = setTimeout(tick, 15_000);
  first.unref?.();
}
