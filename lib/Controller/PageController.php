<?php
namespace OCA\NoteBerg\Controller;

use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IRequest;

class PageController extends Controller {
    public function __construct(string $appName, IRequest $request) {
        parent::__construct($appName, $request);
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function index(): TemplateResponse {
        $response = new TemplateResponse('noteberg', 'index');

        // Allow StorageWorker (Web Worker) and blob: workers for Vite-bundled workers
        $csp = new ContentSecurityPolicy();
        $csp->addAllowedWorkerSrcDomain("'self'");
        $csp->addAllowedWorkerSrcDomain('blob:');
        $response->setContentSecurityPolicy($csp);

        return $response;
    }
}
