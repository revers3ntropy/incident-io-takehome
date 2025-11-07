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
    const { users, handover_start_at: handoverStartAt, handover_interval_days: handoverIntervalDays } = config;

    const handoverStartMs = new Date(handoverStartAt).getTime();
    const intervalMs = handoverIntervalDays * 24 * 60 * 60 * 1000;

    if (intervalMs <= 0) {
        throw new Error("handover_interval_days must be greater than 0");
    }

    // Find the start of the first shift that is active *at or before* the 'from' time.
    const elapsedMs = from.getTime() - handoverStartMs;
    // Math.floor handles 'from' times before the handover_start_at
    const intervalsPassed = Math.floor(elapsedMs / intervalMs);

    let currentShiftStartMs = handoverStartMs + (intervalsPassed * intervalMs);

    // Correctly calculate the user index, handling negative intervals
    let userIdx = ((intervalsPassed % users.length) + users.length) % users.length;

    // Generate shifts until we pass the 'until' time
    while (currentShiftStartMs < until.getTime()) {
        const currentShiftEndMs = currentShiftStartMs + intervalMs;

        baseShifts.push({
            user: users[userIdx],
            start_at: new Date(currentShiftStartMs),
            end_at: new Date(currentShiftEndMs),
        });

        // Move to the next shift
        currentShiftStartMs = currentShiftEndMs;
        userIdx = (userIdx + 1) % users.length;
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
            const ovStart = override.start_at;
            const ovEnd = override.end_at;
            const shiftStart = shift.start_at;
            const shiftEnd = shift.end_at;

            const hasOverlap = (ovStart < shiftEnd) && (ovEnd > shiftStart);

            if (!hasOverlap) {
                // shift is unaffected
                nextSchedule.push(shift);
                continue;
            }

            if (shiftStart < ovStart) {
                nextSchedule.push({
                    user: shift.user,
                    start_at: shiftStart,
                    end_at: ovStart,
                });
            }

            if (shiftEnd > ovEnd) {
                nextSchedule.push({
                    user: shift.user,
                    start_at: ovEnd,
                    end_at: shiftEnd,
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
        const startAt = shift.start_at;
        const endAt = shift.end_at;

        if (startAt >= until || endAt <= from) continue;

        // truncate the shift to fit the window
        const truncatedStart = new Date(Math.max(startAt.getTime(), from.getTime()));
        const truncatedEnd = new Date(Math.min(endAt.getTime(), until.getTime()));

        // only add the shift if it still has a positive duration
        if (truncatedStart.getTime() >= truncatedEnd.getTime())
            continue;

        finalSchedule.push({
            user: shift.user,
            start_at: dateIso(truncatedStart),
            end_at: dateIso(truncatedEnd),
        });

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

// TODO:
// - time zones
// - data persistence
// - nice UI for this, turning it into a web app / native app
// - integration into alerts system
// - 'secondary' on call, hierarchy of alerts
// - multiple teams