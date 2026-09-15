<?php

declare(strict_types=1);

namespace OCA\NoteBerg\Settings;

use OCA\NoteBerg\AppInfo\Application;
use OCP\IL10N;
use OCP\IURLGenerator;
use OCP\Settings\IIconSection;

/**
 * Admin settings section for NoteBerg.
 *
 * Its own section rather than a panel under "Additional settings": the setting
 * it holds is a security control over outbound connections, and an admin
 * looking for it should find it under the app's own name.
 *
 * @psalm-suppress UnusedClass
 */
class AdminSection implements IIconSection {
	public function __construct(
		private IL10N $l,
		private IURLGenerator $urlGenerator,
	) {
	}

	public function getID(): string {
		return Application::APP_ID;
	}

	public function getName(): string {
		return $this->l->t('NoteBerg');
	}

	/**
	 * Ordering among sections. 80 places this below Nextcloud's own groups
	 * without pushing it to the very bottom.
	 */
	public function getPriority(): int {
		return 80;
	}

	/**
	 * A dark glyph, despite being shown on a light background by default.
	 *
	 * Nextcloud's settings navigation applies `filter: var(--background-invert-if-dark)`
	 * to the icon, so it inverts the artwork in dark mode and leaves it alone in
	 * light. The file therefore has to be the light-theme (dark-glyph) version;
	 * the app's own white app.svg came out backwards in both themes. Named
	 * app-dark.svg to match the convention core apps use for the same reason.
	 */
	public function getIcon(): string {
		return $this->urlGenerator->imagePath(Application::APP_ID, 'app-dark.svg');
	}
}
