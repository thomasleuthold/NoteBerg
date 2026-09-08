<?php

declare(strict_types=1);

namespace OCA\NoteBerg\AppInfo;

use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;

class Application extends App implements IBootstrap {
	public const APP_ID = 'noteberg';

	/** @psalm-suppress PossiblyUnusedMethod */
	public function __construct() {
		parent::__construct(self::APP_ID);
	}

	public function register(IRegistrationContext $context): void {
		// The admin settings panel and its section are declared in
		// appinfo/info.xml (<settings><admin>/<admin-section>), which is where
		// Nextcloud reads them from. IRegistrationContext has no equivalent
		// method — only registerDeclarativeSettings(), which is the different
		// schema-driven form.
	}

	public function boot(IBootContext $context): void {
	}
}
