/**
 * Notifications (OpenMasjidOS Fabric). Admin-only helper to send a test message
 * to the configured webhook. Apps send through the REST endpoint
 * POST /api/fabric/notify (see api/fabric.ts), not tRPC.
 */
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { sendNotification } from '../../notify/notify';

export const notificationsRouter = router({
  test: protectedProcedure.mutation(async () => {
    const result = await sendNotification(
      {
        title: 'OpenMasjidOS',
        text: 'This is a test notification. If you can see this, your webhook is set up correctly.',
        level: 'success',
      },
      '__test__',
    );
    if (!result.delivered) {
      const message =
        result.reason === 'disabled' || result.reason === 'bad_url'
          ? 'Turn on notifications and enter a valid webhook URL first.'
          : result.reason === 'rate_limited'
            ? 'Too many notifications just now — please wait a moment and try again.'
            : 'Could not deliver the test. Please check the webhook URL.';
      throw new TRPCError({ code: 'BAD_REQUEST', message });
    }
    return { ok: true };
  }),
});
