<?php
declare(strict_types=1);

/**
 * The AI usage table's rows.
 *
 * Its own partial because two things render it: the admin page on load, and the
 * month picker's re-render, which fetches this same markup rather than building
 * rows in JavaScript. One definition of the row means the two cannot drift —
 * and it keeps the escaping in PHP, where p() is, rather than requiring the
 * script to escape a display name by hand.
 *
 * Expects $usage (a UsageReport::forPeriod() result) and $l in scope.
 *
 * @var array{rows: list<array{uid: string, displayName: string, units: int, deleted: bool}>, total: int, users: int, truncated: bool} $usage
 * @var \OCP\IL10N $l
 */

if ($usage['rows'] === []) { ?>
    <tr>
        <td colspan="2" style="padding:.75em;color:var(--color-text-maxcontrast);">
            <?php p($l->t('No users on this instance.')); ?>
        </td>
    </tr>
<?php } else {
    foreach ($usage['rows'] as $row) {
        // A zero row is dimmed rather than hidden: the table answers "is anyone
        // using this" as well as "who most", and the first question needs the
        // silent accounts visible. Dimming keeps them from competing with the
        // rows that carry a number.
        $dim = $row['units'] === 0 ? 'color:var(--color-text-maxcontrast);' : '';
        $cell = 'padding:.5em .75em;border-top:1px solid var(--color-border);';
        ?>
        <tr>
            <td style="<?php p($cell . $dim); ?>">
                <?php p($row['displayName']); ?>
                <?php
                // The uid alongside the display name, which is not unique: two
                // accounts can carry the same name, and an administrator
                // reconciling this against a bill needs to know which is which.
                if ($row['deleted']) {
                    // Usage with no account behind it any more. Said plainly, so
                    // the row is not read as an account that still exists.
                    ?>
                    <span style="color:var(--color-text-maxcontrast);">
                        (<?php p($l->t('deleted user')); ?>)
                    </span>
                <?php } elseif ($row['displayName'] !== $row['uid']) { ?>
                    <span style="color:var(--color-text-maxcontrast);">
                        (<?php p($row['uid']); ?>)
                    </span>
                <?php } ?>
            </td>
            <td style="<?php p($cell . $dim); ?>text-align:end;font-variant-numeric:tabular-nums;">
                <?php p((string)$row['units']); ?>
            </td>
        </tr>
    <?php }
} ?>
