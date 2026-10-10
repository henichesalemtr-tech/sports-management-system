import * as expireSubscriptionsJob from './expire-subscriptions';
import * as generateNotificationsJob from './generate-notifications';
import * as expiringDocumentsJob from './expiring-documents';
import { recoverStaleJobs } from './runner';

const IN_PROCESS_JOBS = [
  { name: expireSubscriptionsJob.jobName, run: expireSubscriptionsJob.run },
  { name: generateNotificationsJob.jobName, run: generateNotificationsJob.run },
  { name: expiringDocumentsJob.jobName, run: expiringDocumentsJob.run },
];

export async function runInProcessJobs(): Promise<{ recovered: number; results: Record<string, Awaited<ReturnType<(typeof IN_PROCESS_JOBS)[number]['run']>>> }> {
  const recovered = await recoverStaleJobs(60);
  const results: Record<string, Awaited<ReturnType<(typeof IN_PROCESS_JOBS)[number]['run']>>> = {};
  for (const job of IN_PROCESS_JOBS) results[job.name] = await job.run(new Date());
  return { recovered, results };
}
