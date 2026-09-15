<?php

declare(strict_types=1);

namespace OCA\NoteBerg\Settings;

use OCA\NoteBerg\AppInfo\Application;
use OCA\NoteBerg\EndpointPolicy;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\IAppConfig;
use OCP\Settings\ISettings;

/**
 * Admin panel for the AI endpoint allowlist.
 *
 * The list is the only setting here, and it is deliberately the only one: it
 * decides whether this app may open outbound connections at all, which is the
 * one decision that is an administrator's rather than a user's.
 *
 * @psalm-suppress UnusedClass
 */
class AdminSettings implements ISettings {
	public function __construct(
		private IAppConfig $appConfig,
		private IInitialState $initialState,
	) {
	}

	public function getForm(): TemplateResponse {
		$this->initialState->provideInitialState(
			'allowedEndpoints',
			$this->appConfig->getValueString(Application::APP_ID, EndpointPolicy::CONFIG_KEY, ''),
		);
		$this->initialState->provideInitialState('maxEntries', EndpointPolicy::MAX_ENTRIES);

		return new TemplateResponse(Application::APP_ID, 'admin');
	}

	public function getSection(): string {
		return Application::APP_ID;
	}

	public function getPriority(): int {
		return 50;
	}
}
