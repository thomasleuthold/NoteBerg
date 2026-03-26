#!/usr/bin/env node
/**
 * Temporary stub script — creates a minimal "Hello World" Nextcloud app
 * in the expected folder structure so the dev container can load it.
 * Replace with the real Vite build once the Nextcloud port is underway.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function write(relPath, content) {
  const abs = resolve(root, relPath);
  mkdirSync(resolve(abs, '..'), { recursive: true });
  writeFileSync(abs, content.trimStart(), 'utf8');
  console.log(`  wrote ${relPath}`);
}

console.log('Building Nextcloud stub...');

write('appinfo/info.xml', `
<?xml version="1.0"?>
<info xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:noNamespaceSchemaLocation="https://apps.nextcloud.com/schema/apps/info.xsd">
  <id>noteberg</id>
  <name lang="en">NoteBerg</name>
  <description lang="en">Handwritten and typed notes, synchronized across devices.</description>
  <version>0.1.0</version>
  <licence>MIT</licence>
  <author>NoteBerg contributors</author>
  <bugs>https://github.com/your-org/noteberg/issues</bugs>
  <dependencies>
    <nextcloud min-version="27" max-version="34"/>
  </dependencies>
  <navigations>
    <navigation>
      <name>NoteBerg</name>
      <route>noteberg.page.index</route>
    </navigation>
  </navigations>
</info>
`);

write('appinfo/routes.php', `
<?php
return [
    'routes' => [
        ['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],
    ],
];
`);

write('lib/Controller/PageController.php', `
<?php
namespace OCA\\NoteBerg\\Controller;

use OCP\\AppFramework\\Controller;
use OCP\\AppFramework\\Http\\TemplateResponse;
use OCP\\IRequest;

class PageController extends Controller {
    public function __construct(string $appName, IRequest $request) {
        parent::__construct($appName, $request);
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function index(): TemplateResponse {
        return new TemplateResponse('noteberg', 'index');
    }
}
`);

write('templates/index.php', `
<?php
\\OCP\\Util::addScript('noteberg', 'js/noteberg-main');
?>
<div id="noteberg-root"></div>
`);

write('js/noteberg-main.js', `
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('noteberg-root');
  if (!root) return;
  root.style.cssText = 'padding:40px;font-family:sans-serif;';
  root.innerHTML = \`
    <h1>NoteBerg</h1>
    <p>Hello from NoteBerg! The app scaffold is working.</p>
    <p style="color:#888;font-size:0.9em;">This is a stub build — real app coming soon.</p>
  \`;
});
`);

// Nextcloud requires img/app.svg — without it the navigation manager crashes on enable
write('img/app.svg', `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="#0082c9"/>
  <text x="16" y="22" font-size="18" text-anchor="middle" fill="white" font-family="sans-serif" font-weight="bold">N</text>
</svg>
`);

console.log('Done. Run: just nc-up');
