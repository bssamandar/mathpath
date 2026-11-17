/**
 * The weekly league close: every Monday at 00:05 Tashkent time, and once at
 * start (see ../schedule.ts). The close itself is idempotent
 * (`closeFinishedLeagues` in @mathpath/db), so two workers never move a
 * learner twice.
 */
import { type ScheduledTask, type ScheduleOptions, startScheduled, TASHKENT } from '../schedule';

export const LEAGUE_QUEUE = 'league-close';
/** Monday 00:05, after the Sunday-night end of the week. */
export const LEAGUE_CLOSE_PATTERN = '5 0 * * 1';
export const LEAGUE_TIMEZONE = TASHKENT;
export type LeagueCloseOptions = ScheduleOptions;

/**
 * @param close Closes every finished week and returns how many leagues it closed.
 */
export function startLeagueClose(
  close: () => Promise<number>,
  options: LeagueCloseOptions,
): Promise<ScheduledTask> {
  return startScheduled(
    LEAGUE_QUEUE,
    LEAGUE_CLOSE_PATTERN,
    async () => {
      const closed = await close();
      return closed > 0 ? `closed ${closed} league(s)` : undefined;
    },
    options,
  );
}
