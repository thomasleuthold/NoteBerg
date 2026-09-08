<?php
declare(strict_types=1);

/**
 * The line under the AI usage table.
 *
 * A partial for the same reason the rows are: the month picker re-renders it,
 * and one definition keeps the served markup and the reloaded markup identical.
 *
 * Expects $usage (a UsageReport::forPeriod() result) and $l in scope.
 *
 * @var array{rows: list<array{uid: string, displayName: string, units: int, deleted: bool}>, total: int, users: int, truncated: bool} $usage
 * @var \OCP\IL10N $l
 */

// The period's real total, which is not the visible rows' total when the table
// has been cut — reporting the truncated sum would understate the spend, and
// this line is the one an administrator checks against a bill.
p($l->n('%n page sent this month.', '%n pages sent this month.', $usage['total']));

if ($usage['truncated']) {
    p(' ');
    // Said explicitly rather than letting the table simply end: a cut table that
    // does not admit to being cut reads as a complete list of the instance's
    // users, which for the zero rows is exactly the wrong conclusion.
    p($l->t(
        'Showing the %1$s users with the most usage, of %2$s.',
        [(string)count($usage['rows']), (string)$usage['users']],
    ));
}
