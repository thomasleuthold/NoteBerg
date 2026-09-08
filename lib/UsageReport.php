<?php

declare(strict_types=1);

namespace OCA\NoteBerg;

use OCP\IUserManager;

/**
 * The admin panel's view of the usage counter: rows with names on them.
 *
 * Separate from UsageCounter because the two answer to different things. The
 * counter is a spend control on the request path, and it must not grow a
 * dependency on the user backend — enumerating accounts to serve a quota check
 * would put the slowest thing on the page in front of the fastest. This class
 * is the reporting side, reached once per admin page view, and it is where the
 * account list belongs.
 */
class UsageReport {
	/**
	 * Rows rendered at once.
	 *
	 * An instance with a large user directory would otherwise render a row per
	 * account into the settings page, which is slow to build and useless to
	 * read. Rows are ordered spend-first, so the cut falls on users who have
	 * sent nothing — the ones the table was least able to say anything about.
	 * The caller is told the total so it can say what was left out rather than
	 * silently truncating.
	 */
	public const MAX_ROWS = 200;

	public function __construct(
		private UsageCounter $counter,
		private IUserManager $userManager,
		private \OCP\IL10N $l,
	) {
	}

	/**
	 * One period's usage, one row per account, spend first.
	 *
	 * Every account appears, including those that have sent nothing: the
	 * question an administrator brings to this table is as often "is anyone
	 * using this" as "who is using it most", and a table of only active users
	 * cannot answer the first.
	 *
	 * A uid with usage but no account still gets a row, labelled by its uid: the
	 * accounting outlives the account, and dropping those rows would make the
	 * displayed total disagree with what was actually spent.
	 *
	 * @return array{rows: list<array{uid: string, displayName: string, units: int, deleted: bool}>, total: int, users: int, truncated: bool}
	 */
	public function forPeriod(string $task, string $period): array {
		$used = $this->counter->report($task, $period);

		$names = $this->displayNames();

		$rows = [];
		foreach ($names as $uid => $displayName) {
			$rows[] = [
				'uid' => $uid,
				'displayName' => $displayName,
				'units' => $used[$uid] ?? 0,
				'deleted' => false,
			];
		}
		// Usage belonging to no current account. Kept, and marked, so the column
		// adds up to what was really spent this period.
		foreach ($used as $uid => $units) {
			if (!isset($names[$uid])) {
				$rows[] = [
					'uid' => $uid,
					'displayName' => $uid,
					'units' => $units,
					'deleted' => true,
				];
			}
		}

		// Spend first, then by display name so the zero rows below the active
		// ones read as a directory rather than as backend order. usort is not
		// stable across PHP versions in principle, hence the uid tiebreak: two
		// users with the same name and the same count must not swap between
		// page loads.
		usort($rows, static function (array $a, array $b): int {
			return $b['units'] <=> $a['units']
				?: strcasecmp($a['displayName'], $b['displayName'])
				?: strcmp($a['uid'], $b['uid']);
		});

		$total = array_sum($used);
		$users = count($rows);

		return [
			'rows' => array_slice($rows, 0, self::MAX_ROWS),
			// The period's real total, not the visible rows' — a truncated table
			// that also truncated its total would understate the spend.
			'total' => $total,
			'users' => $users,
			'truncated' => $users > self::MAX_ROWS,
		];
	}

	/**
	 * Every account on the instance, uid => display name.
	 *
	 * callForSeenUsers rather than search(''): it walks the users the instance
	 * has actually seen, which is what a settings page wants — search() on some
	 * backends queries a remote directory, and an LDAP round trip does not
	 * belong in a page render.
	 *
	 * Its own method, and protected, so a test can supply an account list
	 * without standing up a user backend: IUserManager is a wide interface, and
	 * stubbing all of it to answer one call would bury what those tests say.
	 *
	 * @return array<string, string>
	 */
	protected function displayNames(): array {
		$names = [];
		$this->userManager->callForSeenUsers(static function (\OCP\IUser $user) use (&$names): void {
			$names[$user->getUID()] = $user->getDisplayName();
		});
		return $names;
	}

	/**
	 * Periods offered by the picker, newest first, current month always present.
	 *
	 * The current month is included even with nothing recorded yet, so the panel
	 * has something to select on an instance where the feature has just been
	 * switched on — a picker whose only options were historical would look
	 * broken in exactly that case.
	 *
	 * @return list<string>
	 */
	public function periods(string $task): array {
		$periods = $this->counter->periods($task);
		$current = UsageCounter::periodKey();
		if (!in_array($current, $periods, true)) {
			array_unshift($periods, $current);
		}
		return $periods;
	}

	/**
	 * 'YYYY-MM' as a month and year for a heading.
	 *
	 * Formatted here rather than in the template so the JS path and the
	 * server-rendered path cannot drift: the picker rewrites the heading from
	 * what this returns, and two implementations of one format would eventually
	 * disagree about a month name.
	 *
	 * Localised through IL10N rather than gmdate('F Y'), whose month names are
	 * always English — the rest of this panel is translated, and a German admin
	 * reading "September 2026" under a translated heading would be the only
	 * untranslated string on the page. The day is fixed at the 1st because only
	 * the month and year are shown.
	 */
	public function label(string $period): string {
		$time = strtotime($period . '-01 00:00:00 UTC');
		if ($time === false) {
			return $period;
		}

		// The month name by number, so the translator supplies the names their
		// language actually uses rather than the catalogue trying to inflect an
		// English one. Nextcloud's own l10n does the same.
		$months = [
			1 => $this->l->t('January'),
			$this->l->t('February'),
			$this->l->t('March'),
			$this->l->t('April'),
			$this->l->t('May'),
			$this->l->t('June'),
			$this->l->t('July'),
			$this->l->t('August'),
			$this->l->t('September'),
			$this->l->t('October'),
			$this->l->t('November'),
			$this->l->t('December'),
		];

		$month = (int)gmdate('n', $time);
		// %1$s is a month name, %2$s a four-digit year: ordered by the catalogue
		// so a language that puts the year first can say so.
		return $this->l->t('%1$s %2$s', [$months[$month] ?? $period, gmdate('Y', $time)]);
	}
}
