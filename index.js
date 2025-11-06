import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import * as fs from 'fs';

/** @typedef {{
 * users: string[],
 * handover_start_at: string,
 * handover_interval_days: number
 * }} ScheduleConfig */

/** @typedef {{
 * user: string,
 * start_at: string,
 * end_at: string
 * }} Override
 */

/** @typedef {{
 * user: string,
 * start_at: string,
 * end_at: string
 * }} ScheduleElement
 */

/** @typedef {{
 * user: string,
 * start_at: Date,
 * end_at: Date
 * }} WorkingScheduleElement
 */


/**
 * helper to format a date in ISO format without milliseconds
 * @param {Date} d
 * @returns {string}
 */
function dateIso(d) {
    // .toISOString() is e.g. "2025-11-10T17:00:00.000Z"
    // We split on the '.' and take the first part, then add 'Z'
    return d.toISOString().split('.')[0] + "Z";
}

/**
 * generates the base schedule (un-truncated) for a given time window
 * @param {ScheduleConfig} config
 * @param {Date} from
 * @param {Date} until
 * @returns {WorkingScheduleElement[]}
 */
function generateBaseSchedule(config, from, until) {
    /** @type {WorkingScheduleElement[]} */
    const baseShifts = [];
    const { users, handover_start_at, handover_interval_days } = config;
    const num_users = users.length;

    const handover_start_ms = new Date(handover_start_at).getTime();
    const interval_ms = handover_interval_days * 24 * 60 * 60 * 1000;

    if (interval_ms <= 0) {
        throw new Error("handover_interval_days must be greater than 0");
    }

    // Find the start of the first shift that is active *at or before* the 'from' time.
    const elapsed_ms = from.getTime() - handover_start_ms;
    // Math.floor handles 'from' times before the handover_start_at
    const intervals_passed = Math.floor(elapsed_ms / interval_ms);

    let current_shift_start_ms = handover_start_ms + (intervals_passed * interval_ms);

    // Correctly calculate the user index, handling negative intervals
    let current_user_index = ((intervals_passed % num_users) + num_users) % num_users;

    // Generate shifts until we pass the 'until' time
    while (current_shift_start_ms < until.getTime()) {
        const current_shift_end_ms = current_shift_start_ms + interval_ms;

        baseShifts.push({
            user: users[current_user_index],
            start_at: new Date(current_shift_start_ms),
            end_at: new Date(current_shift_end_ms),
        });

        // Move to the next shift
        current_shift_start_ms = current_shift_end_ms;
        current_user_index = (current_user_index + 1) % num_users;
    }

    return baseShifts;
}

/**
 * Applies overrides to a base schedule, splitting shifts as needed.
 * @param {WorkingScheduleElement[]} baseSchedule
 * @param {WorkingScheduleElement[]} parsedOverrides - Overrides with Date objects
 * @returns {WorkingScheduleElement[]}
 */
function applyOverrides(baseSchedule, parsedOverrides) {
    let workingSchedule = [...baseSchedule];

    // sort overrides by start time
    const sortedOverrides = parsedOverrides.sort((a, b) => a.start_at.getTime() - b.start_at.getTime());

    for (const override of sortedOverrides) {
        const nextSchedule = [];

        for (const shift of workingSchedule) {
            const ov_start = override.start_at;
            const ov_end = override.end_at;
            const shift_start = shift.start_at;
            const shift_end = shift.end_at;

            const has_overlap = (ov_start < shift_end) && (ov_end > shift_start);

            if (!has_overlap) {
                // shift is unaffected
                nextSchedule.push(shift);
                continue;
            }

            if (shift_start < ov_start) {
                nextSchedule.push({
                    user: shift.user,
                    start_at: shift_start,
                    end_at: ov_start,
                });
            }

            if (shift_end > ov_end) {
                nextSchedule.push({
                    user: shift.user,
                    start_at: ov_end,
                    end_at: shift_end,
                });
            }

            // original 'shift' is now 'consumed' and replaced
            // by the 'before' and/or 'after' parts
        }

        // add the override itself to the list
        nextSchedule.push(override);

        // re-sort the schedule for the next iteration, as splitting
        // and adding the override may have changed the order
        workingSchedule = nextSchedule.sort((a, b) => a.start_at.getTime() - b.start_at.getTime());
    }

    return workingSchedule;
}

/**
 * filters and truncates a final schedule to fit the query window.
 * @param {WorkingScheduleElement[]} schedule
 * @param {Date} from
 * @param {Date} until
 * @returns {ScheduleElement[]}
 */
function truncateAndFilterSchedule(schedule, from, until) {
    const finalSchedule = [];

    for (const shift of schedule) {
        const shift_start = shift.start_at;
        const shift_end = shift.end_at;

        // check for overlap with the query window
        const has_overlap = (shift_start < until) && (shift_end > from);

        if (has_overlap) {
            // truncate the shift to fit the window
            const truncated_start = new Date(Math.max(shift_start.getTime(), from.getTime()));
            const truncated_end = new Date(Math.min(shift_end.getTime(), until.getTime()));

            // only add the shift if it still has a positive duration
            if (truncated_start.getTime() < truncated_end.getTime()) {
                finalSchedule.push({
                    user: shift.user,
                    start_at: dateIso(truncated_start),
                    end_at: dateIso(truncated_end),
                });
            }
        }
    }

    return finalSchedule;
}

/**
 * @param {ScheduleConfig} config
 * @param {Override[]} overrides
 * @param {Date} fromDate
 * @param {Date} untilDate
 * @returns {ScheduleElement[]}
 */
function makeSchedule(config, overrides, fromDate, untilDate) {
    // generate un-truncated base shifts
    const baseShifts = generateBaseSchedule(config, fromDate, untilDate);

    // parse strings into dates
    const parsedOverrides = overrides.map(ov => ({
        user: ov.user,
        start_at: new Date(ov.start_at),
        end_at: new Date(ov.end_at)
    }));

    // apply overrides to base schedule
    const overriddenSchedule = applyOverrides(baseShifts, parsedOverrides);

    // truncate, filter and format the schedule
    return truncateAndFilterSchedule(overriddenSchedule, fromDate, untilDate);
}

function main() {
    /** @type {Record<string, string>} */
    const argv = yargs(hideBin(process.argv)).options({
        schedule: { type: 'string', required: true },
        overrides: { type: 'string', required: true },
        from: { type: 'string', required: true },
        until: { type: 'string', required: true },
    }).parseSync();

    const { schedule, overrides, from, until } = argv;

    // assume these files exist and are valid JSON
    /** @type {ScheduleConfig} */
    const scheduleData = JSON.parse(String(fs.readFileSync(schedule)));
    /** @type {Override[]} */
    const overridesData = JSON.parse(String(fs.readFileSync(overrides)));

    const fromDate = new Date(from);
    const untilDate = new Date(until);

    if (fromDate.getTime() >= untilDate.getTime()) {
        throw new Error("'--from' must be earlier than '--until'");
    }

    console.log(JSON.stringify(makeSchedule(scheduleData, overridesData, fromDate, untilDate), null, 4));
}

main();