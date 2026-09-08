<?php

declare(strict_types=1);

namespace OCA\NoteBerg\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * The AI usage counter table — this application's first schema.
 *
 * A table rather than app config or the distributed cache, for reasons recorded
 * in the design (§9.1):
 *
 *   - IAppConfig has no atomic increment, so a counter would be read-modify-write
 *     and would undercount whenever two requests overlap — precisely the
 *     condition a shared-account quota exists for. Its non-lazy values also load
 *     on every request to every app, and one key per user *per task* per period
 *     makes that cost scale with the dimension being added.
 *   - The distributed cache has atomic inc() and is already required by the
 *     async proxy path, but a cache is evictable by design: quota would silently
 *     reset under memory pressure, which is the wrong failure direction for a
 *     spend control.
 *
 * The unique index is what makes the increment atomic and is therefore part of
 * the correctness of the quota, not merely an optimisation.
 *
 * @psalm-suppress UnusedClass
 */
class Version000000Date20260904000000 extends SimpleMigrationStep {
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if ($schema->hasTable('noteberg_ai_usage')) {
			return null;
		}

		$table = $schema->createTable('noteberg_ai_usage');

		$table->addColumn('id', Types::BIGINT, [
			'autoincrement' => true,
			'notnull' => true,
		]);
		$table->addColumn('uid', Types::STRING, [
			'notnull' => true,
			'length' => 64,
		]);
		// The task the units were spent on. Present from the outset although
		// recognition is the only task today: each future AI feature carries its
		// own model and its own cap, so the task is a first-class dimension and
		// adding it later would mean migrating a live table.
		$table->addColumn('task', Types::STRING, [
			'notnull' => true,
			'length' => 32,
		]);
		// 'YYYY-MM'. A string rather than a date so the period granularity can
		// change without a column type change, and so the unique index below
		// compares exactly what the counter keys on.
		$table->addColumn('period_key', Types::STRING, [
			'notnull' => true,
			'length' => 16,
		]);
		// Deliberately generic. Recognition sends one request per page and
		// presents its cap as "pages", but a later task will count something
		// else, and a column named for one task's unit would need renaming.
		$table->addColumn('units', Types::INTEGER, [
			'notnull' => true,
			'default' => 0,
		]);

		$table->setPrimaryKey(['id']);
		// Both the lookup path and the guarantee that one row exists per
		// (user, task, period) — which is what lets the increment be a single
		// atomic statement rather than a read followed by a write.
		$table->addUniqueIndex(['uid', 'task', 'period_key'], 'noteberg_usage_uniq');

		return $schema;
	}
}
