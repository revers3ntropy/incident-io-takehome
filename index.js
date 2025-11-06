import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import * as fs from 'fs';

/** @typedef {{
 *   users: string[],
 *   handover_start_at: string,
 *   handover_interval_days: number
 * }} ScheduleConfig */

/** @typedef {{
 *   user: string,
 *   start_at: string,
 *   end_at: string
 * }} Override
 */

/** @typedef {{
 *  user: string,
 *  start_at: string,
 *  end_at: string
 * }} ScheduleElement
 */

/**
 * Helper to format a date in ISO format without milliseconds
 * @param {Date} d
 * @returns {string}
 */
function dateIso(d) {
    return d.toISOString().split('.')[0]+"Z";
}

/**
 * @param {ScheduleConfig} config
 * @param {Date} from
 * @param {Date} until
 * @returns {ScheduleElement[]}
 */
function makeBaseSchedule(config, from, until) {
    let currentStart = from.getTime();
    const end = until.getTime();
    /** @type {ScheduleElement[]} */
    let schedule = [];
    let currentUserIdx = 0;
    const intervalMs = config.handover_interval_days * 24 * 60 * 60 * 1000;

    while (currentStart < end) {
        schedule.push({
            user: config.users[currentUserIdx],
            start_at: dateIso(new Date(currentStart)),
            end_at: dateIso(new Date(Math.min(currentStart + intervalMs, end) )),
        });
        currentStart += intervalMs;
        currentUserIdx = (currentUserIdx + 1) % config.users.length;
    }

    return schedule;
}

/**
 * @param {ScheduleElement[]} baseSchedule
 * @param {Override[]} overrides
 * @returns {ScheduleElement[]}
 */
function addOverrides(baseSchedule, overrides) {
    // mutate and return a deep copy of the base schedule, so the interface of this function is functional
    /** @type {ScheduleElement[]} */
    let schedule = [...baseSchedule.map(e => ({...e}))];

    // assume there are no overlaps, so the end of [n] will always be before the start of [n+1]
    const sortedOverrides = overrides.sort((a, b) => a.start_at - b.start_at);
    for (const override of sortedOverrides) {
        // find the index of the schedule element in which the start of the override occurs in.
        // note that because overrides can never start at the same time as a new schedule,
        // we don't need to check for this case.
        let overridingFromIdx = schedule.indexOf(
            schedule.find(s => new Date(s.start_at).getTime() < new Date(override.start_at).getTime()
                && new Date(s.end_at).getTime() > new Date(override.start_at).getTime())
        );

        // case 1: the override ends in the same schedule element as it began
        if (new Date(schedule[overridingFromIdx].end_at).getTime() > new Date(override.end_at).getTime()) {

            const originalEnd = schedule[overridingFromIdx].end_at;
            schedule[overridingFromIdx].end_at = override.start_at;
            schedule.splice(overridingFromIdx + 1, 0, {
                user: override.user,
                start_at: override.start_at,
                end_at: override.end_at,
            });
            schedule.splice(overridingFromIdx + 2, 0, {
                user: schedule[overridingFromIdx].user,
                start_at: override.end_at,
                end_at: originalEnd,
            });
            continue;
        }

        // case 2: the override carries over into the next schedule element
        schedule[overridingFromIdx].end_at = override.start_at;
        schedule.splice(overridingFromIdx + 1, 0, {
            user: override.user,
            start_at: override.start_at,
            end_at: override.end_at,
        });
        schedule[overridingFromIdx + 2].start_at = override.end_at;

        // case 3: the override is longer than the next schedule element,
        //         so at least one schedule element from the base schedule is just removed.

        // this case will not be handled as it is unrealistic, system could be extended to handle this.
    }

    return schedule
}

/**
 * @param {ScheduleConfig} config
 * @param {Override[]} overrides
 * @param {Date} from
 * @param {Date} until
 * @returns {ScheduleElement[]}
 */
function makeSchedule(config, overrides, from, until) {
    return addOverrides(makeBaseSchedule(config, from, until), overrides);
}

function main() {
    /** @type {Record<string, string>} */
    const argv = yargs(hideBin(process.argv)).parse();

    const { schedule, overrides, from, until } = argv;

    // assume these files exist and are valid JSON
    /** @type {ScheduleConfig} */
    const scheduleData = JSON.parse(String(fs.readFileSync(schedule)));
    /** @type {Override[]} */
    const overridesData = JSON.parse(String(fs.readFileSync(overrides)));

    const fromDate = new Date(from);
    const untilDate = new Date(until);

    console.log(JSON.stringify(makeSchedule(scheduleData, overridesData, fromDate, untilDate), null, 4));
}

main();