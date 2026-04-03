<?php

declare(strict_types=1);

namespace OCA\NoteBerg\Controller;

use OCA\NoteBerg\AppInfo\Application;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\FrontpageRoute;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\OpenAPI;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IRequest;

/**
 * @psalm-suppress UnusedClass
 */
class PageController extends Controller {
	public function __construct(IRequest $request) {
		parent::__construct(Application::APP_ID, $request);
	}

	#[NoCSRFRequired]
	#[NoAdminRequired]
	#[OpenAPI(OpenAPI::SCOPE_IGNORE)]
	#[FrontpageRoute(verb: 'GET', url: '/')]
	public function index(): TemplateResponse {
		$response = new TemplateResponse(Application::APP_ID, 'index');

		// Allow StorageWorker (Web Worker) and blob: workers for Vite-bundled workers
		$csp = new ContentSecurityPolicy();
		$csp->addAllowedWorkerSrcDomain("'self'");
		$csp->addAllowedWorkerSrcDomain('blob:');
		$response->setContentSecurityPolicy($csp);

		return $response;
	}
}
