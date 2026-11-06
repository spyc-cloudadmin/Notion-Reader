export function startColdStartRefresh({ config, publisher, logger }) {
  if (!config.refreshOnStart) return;
  void (async () => {
    logger.info({ event: 'cold_start_refresh_started', roots: config.lessons.length });
    for (const lesson of config.lessons) {
      try {
        await publisher.publish(lesson.slug);
      } catch (error) {
        logger.error({ event: 'cold_start_refresh_failed', slug: lesson.slug, code: error.code ?? 'internal_error' });
      }
    }
    logger.info({ event: 'cold_start_refresh_finished' });
  })();
}
