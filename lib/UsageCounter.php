<?php

declare(strict_types=1);

namespace OCA\NoteBerg;

use OCP\DB\Exception as DbException;
use OCP\IDBConnection;

/**
 * Per-user, per-task request accounting for the AI features.
 *
 * The unit is a **request**, not a token. Token accounting was considered and
 * dropped: Replicate reports no token usage at all — it bills compute seconds —
 * so a token limit would be unimplementable for one of the two providers and
 * would silently not apply there. Tokens are also only knowable *after* the
 * spend, whereas a request count can be enforced before it.
 *
 * The stored unit is generic. Recognition sends one request per page and
 * presents its cap as "pages", but that is a label at the task's own settings;
 * a later task will count something else.
 *
 * Counting happens at dispatch, before the upstream call, so a failed request
 * still consumes quota — correct often enough to be the right default, since a
 * request that reached the provider and failed there was frequently still
 * billed.
 */
class UsageCounter {
	private const TABLE = 'noteberg_ai_usage';

	public function __construct(
		private IDBConnection $db,
	) {
	}

	/**
	 * The period a timestamp falls in.
	 *
	 * Monthly, because that is what providers bill on. A daily cap was
	 * considered as a burst guard and dropped: it doubles the rows and the
	 * administrator fields for a bound the monthly cap already provides.
	 *
	 * UTC, so a period boundary is the same instant for every user of an
	 * instance regardless of where they are — a quota that reset at a different
	 * moment per user would be impossible to reason about from the admin panel.
	 */
	public static function periodKey(?int $timestamp = null): string {
		return gmdate('Y-m', $timestamp ?? time());
	}

	/**
	 * Units already spent by one user on one task this period.
	 */
	public function used(string $uid, string $task, ?string $period = null): int {
		$period ??= self::periodKey();

		$query = $this->db->getQueryBuilder();
		$query->select('units')
			->from(self::TABLE)
			->where($query->expr()->eq('uid', $query->createNamedParameter($uid)))
			->andWhere($query->expr()->eq('task', $query->createNamedParameter($task)))
			->andWhere($query->expr()->eq('period_key', $query->createNamedParameter($period)));

		$result = $query->executeQuery();
		$row = $result->fetch();
		$result->closeCursor();

		return $row === false ? 0 : (int)$row['units'];
	}

	/**
	 * Record one unit of usage.
	 *
	 * Insert-then-update rather than read-then-write: the unique index on
	 * (uid, task, period_key) is what makes this safe under concurrency. Two
	 * requests racing to create the first row of a period both attempt the
	 * insert, one loses on the constraint, and the loser falls through to the
	 * atomic UPDATE — so neither is lost. A read-modify-write would drop one.
	 *
	 * @return int the new total, or -1 when accounting failed
	 */
	public function record(string $uid, string $task, int $units = 1, ?string $period = null): int {
		$period ??= self::periodKey();

		try {
			$insert = $this->db->getQueryBuilder();
			$insert->insert(self::TABLE)
				->values([
					'uid' => $insert->createNamedParameter($uid),
					'task' => $insert->createNamedParameter($task),
					'period_key' => $insert->createNamedParameter($period),
					'units' => $insert->createNamedParameter($units, \OCP\DB\QueryBuilder\IQueryBuilder::PARAM_INT),
				]);
			$insert->executeStatement();
			return $units;
		} catch (DbException $e) {
			// The row already exists — the overwhelmingly common case after the
			// first request of a period. Anything else is a real failure and is
			// re-thrown to the caller.
			if ($e->getReason() !== DbException::REASON_UNIQUE_CONSTRAINT_VIOLATION) {
				throw $e;
			}
		}

		$update = $this->db->getQueryBuilder();
		$update->update(self::TABLE)
			->set('units', $update->func()->add('units', $update->createNamedParameter($units, \OCP\DB\QueryBuilder\IQueryBuilder::PARAM_INT)))
			->where($update->expr()->eq('uid', $update->createNamedParameter($uid)))
			->andWhere($update->expr()->eq('task', $update->createNamedParameter($task)))
			->andWhere($update->expr()->eq('period_key', $update->createNamedParameter($period)));
		$update->executeStatement();

		return $this->used($uid, $task, $period);
	}

	/**
	 * Every user's spend on one task in one period, keyed by uid.
	 *
	 * Only users the table has a row for: a user appears here once they have
	 * sent something. Zero-filling the instance's full account list is the
	 * caller's job, not this one's — the accounting table has no opinion on who
	 * exists, and asking it to enumerate accounts would couple the counter to
	 * the user backend for the sake of one screen.
	 *
	 * Ordered by spend rather than by name so the admin panel's first rows are
	 * the ones worth looking at. A tie falls back to uid, so the order is total
	 * rather than merely deterministic-looking — two users on the same count
	 * would otherwise swap places between page loads.
	 *
	 * @return array<string, int>
	 */
	public function report(string $task, ?string $period = null): array {
		$period ??= self::periodKey();

		$query = $this->db->getQueryBuilder();
		$query->select('uid', 'units')
			->from(self::TABLE)
			->where($query->expr()->eq('task', $query->createNamedParameter($task)))
			->andWhere($query->expr()->eq('period_key', $query->createNamedParameter($period)))
			->orderBy('units', 'DESC')
			->addOrderBy('uid', 'ASC');

		$result = $query->executeQuery();
		$report = [];
		while (($row = $result->fetch()) !== false) {
			$report[(string)$row['uid']] = (int)$row['units'];
		}
		$result->closeCursor();

		return $report;
	}

	/**
	 * The periods this task has any accounting for, newest first.
	 *
	 * Drives the admin panel's period picker. Read from the table rather than
	 * generated as a range of recent months, so the picker never offers a month
	 * with nothing behind it — including after prune() has removed history,
	 * where a generated list would offer months that are now empty.
	 *
	 * The period key sorts lexically because it is 'YYYY-MM' with a padded
	 * month, which is the reason that format was chosen over one without the
	 * leading zero.
	 *
	 * @return list<string>
	 */
	public function periods(string $task): array {
		$query = $this->db->getQueryBuilder();
		$query->selectDistinct('period_key')
			->from(self::TABLE)
			->where($query->expr()->eq('task', $query->createNamedParameter($task)))
			->orderBy('period_key', 'DESC');

		$result = $query->executeQuery();
		$periods = [];
		while (($row = $result->fetch()) !== false) {
			$periods[] = (string)$row['period_key'];
		}
		$result->closeCursor();

		return $periods;
	}

	/**
	 * Drop accounting rows for periods that have ended.
	 *
	 * Called from the admin panel rather than by a background job: the table
	 * gains one row per active user per task per month, so it grows slowly
	 * enough that a cron entry would be more machinery than the problem needs,
	 * and an administrator clearing history is a deliberate act.
	 *
	 * @return int rows removed
	 */
	public function prune(?string $before = null): int {
		$before ??= self::periodKey();

		$query = $this->db->getQueryBuilder();
		$query->delete(self::TABLE)
			->where($query->expr()->lt('period_key', $query->createNamedParameter($before)));

		return $query->executeStatement();
	}
}
